import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import pool from '../db.server.ts';
import {
  getCancellableMembership,
  recordCancellationRequest,
  undoCancellationRequest,
  type CancellableMembership,
} from '../lib/db.ts';
import {
  accessUntilAfterCancel,
  cancelContract,
  cancellationPolicy,
  readMemberContract,
  type MemberContract,
} from '../lib/membership-cancellation.ts';
import type { AdminClient } from '../lib/membership-provisioning.ts';
import { shopAdmin } from '../shop-admin.server.ts';
import type { ProxyCustomer } from '../lib/shopify-auth.ts';
import { json, proxyError, withProxyAuth } from '../lib/proxy.ts';

/**
 * GET  /apps/spa/membership — the member's plan, and whether they can cancel.
 * POST /apps/spa/membership — cancel it.
 *
 * Kept apart from /closet so the closet stays a database read: this one asks
 * Shopify about the contract, and is only fetched when the member opens
 * "Manage membership".
 *
 * Which contract is decided from the signed customer alone — nothing in the
 * request names one — and the contract Shopify returns must belong to that
 * customer too, so a stale or mismatched row can never cancel someone else's.
 */

type Found =
  | { kind: 'none' }
  | { kind: 'ok'; membership: CancellableMembership; contract: MemberContract; admin: AdminClient };

async function findContract(customer: ProxyCustomer): Promise<Found> {
  const membership = await getCancellableMembership(pool, customer.shop, customer.shopifyCustomerId);
  if (!membership) return { kind: 'none' };

  const admin = await shopAdmin.forShop(customer.shop);
  const contract = await readMemberContract(admin, membership.shopifyContractId);
  // Ownership, checked against Shopify rather than only our own join.
  if (!contract || contract.customerId !== customer.shopifyCustomerId) return { kind: 'none' };

  return { kind: 'ok', membership, contract, admin };
}

function describe(membership: CancellableMembership, contract: MemberContract) {
  const policy = cancellationPolicy(contract);
  // Already cancelled from the closet: the contract reads CANCELLED, and what
  // the member needs is the date it ends, not "not active".
  const cancelled = Boolean(membership.cancelledAt);
  return {
    planName: policy.planName,
    nextBillingDate: cancelled ? null : contract.nextBillingDate?.toISOString() ?? null,
    paidCycles: policy.paidCycles,
    minCycles: policy.minCycles,
    canCancel: cancelled ? false : policy.canCancel,
    reason: cancelled ? 'already_cancelled' : policy.reason,
    cancellableFrom: policy.cancellableFrom?.toISOString() ?? null,
    cancelled,
    endsOn: cancelled ? membership.accessUntil?.toISOString() ?? null : null,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) =>
  withProxyAuth(request, async (customer) => {
    const found = await findContract(customer);
    if (found.kind === 'none') return json({ ok: true, signedIn: true, membership: null });
    return json({ ok: true, signedIn: true, membership: describe(found.membership, found.contract) });
  });

export const action = async ({ request }: ActionFunctionArgs) =>
  withProxyAuth(request, async (customer) => {
    if (request.method !== 'POST') return proxyError('method_not_allowed', 405);

    const found = await findContract(customer);
    if (found.kind === 'none') return proxyError('no_membership', 404);
    const { membership, contract, admin } = found;

    // A second click, or a second tab: the first already did it.
    if (membership.cancelledAt) {
      return json({ ok: true, membership: describe(membership, contract) });
    }

    const policy = cancellationPolicy(contract);
    if (!policy.canCancel) {
      return json({
        ok: false,
        error: 'cannot_cancel',
        httpStatus: 409,
        membership: describe(membership, contract),
      });
    }

    const accessUntil = accessUntilAfterCancel(contract);
    await recordCancellationRequest(pool, membership.id, accessUntil);
    try {
      await cancelContract(admin, contract.id);
    } catch (error) {
      await undoCancellationRequest(pool, membership.id);
      throw error;
    }

    console.log(
      `[membership] ${customer.shop}: ${customer.shopifyCustomerId} cancelled ${contract.id}` +
        ` after ${policy.paidCycles} paid cycle(s); active until ${accessUntil?.toISOString() ?? 'now'}`,
    );

    return json({
      ok: true,
      membership: describe({ ...membership, cancelledAt: new Date(), accessUntil }, contract),
    });
  });
