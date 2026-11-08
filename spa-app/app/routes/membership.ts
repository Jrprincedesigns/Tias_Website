import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import pool from '../db.server.ts';
import {
  getCancellableMembership,
  recordCancellationRequest,
  recordCancelRequest,
  undoCancellationRequest,
  withdrawCancelRequest,
  type CancellableMembership,
} from '../lib/db.ts';
import {
  accessUntilAfterCancel,
  cancelContract,
  cancellationPolicy,
  minimumTermEndsOn,
  readMemberContract,
  type MemberContract,
} from '../lib/membership-cancellation.ts';
import type { AdminClient } from '../lib/membership-provisioning.ts';
import { shopAdmin } from '../shop-admin.server.ts';
import type { ProxyCustomer } from '../lib/shopify-auth.ts';
import { json, proxyError, withProxyAuth } from '../lib/proxy.ts';

/**
 * GET  /apps/spa/membership — the member's plan, and whether they can cancel.
 * POST /apps/spa/membership — `{ intent }`, one of:
 *   - `cancel` (the default): cancel now. Refused under the minimum term.
 *   - `request_cancel`: under the minimum, ask to cancel once it is paid. The
 *     daily job carries it out (membership-cancellation.ts).
 *   - `withdraw`: take a request back, until the job has carried it out.
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
  const cancelRequested = !cancelled && Boolean(membership.cancelRequestedAt);
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
    // Under the minimum, the member may ask instead — once.
    canRequestCancel: !cancelled && !cancelRequested && policy.reason === 'minimum_term',
    cancelRequested,
    // The end of the minimum: when a request ends the membership, and the
    // date a member asking now would be told.
    cancelEndsOn: cancelRequested
      ? membership.cancelEndsOn?.toISOString() ?? null
      : minimumTermEndsOn(contract)?.toISOString() ?? null,
  };
}

type Intent = 'cancel' | 'request_cancel' | 'withdraw';

/** The body is optional: an empty one is a plain cancel, as it always was. */
async function readIntent(request: Request): Promise<Intent | null> {
  const text = await request.text();
  if (!text.trim()) return 'cancel';
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const intent = (body as { intent?: unknown } | null)?.intent ?? 'cancel';
  return intent === 'cancel' || intent === 'request_cancel' || intent === 'withdraw' ? intent : null;
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
    const intent = await readIntent(request);
    if (!intent) return proxyError('invalid_request', 400);

    const found = await findContract(customer);
    if (found.kind === 'none') return proxyError('no_membership', 404);
    const { membership, contract, admin } = found;

    // A second click, or a second tab: the first already did it.
    if (membership.cancelledAt) {
      return json({ ok: true, membership: describe(membership, contract) });
    }

    if (intent === 'withdraw') {
      // Nothing to withdraw is the same answer: the member is staying.
      await withdrawCancelRequest(pool, membership.id);
      console.log(`[membership] ${customer.shop}: ${customer.shopifyCustomerId} withdrew their cancel request`);
      return json({
        ok: true,
        membership: describe({ ...membership, cancelRequestedAt: null, cancelEndsOn: null }, contract),
      });
    }

    if (intent === 'request_cancel') {
      if (membership.cancelRequestedAt) {
        return json({ ok: true, membership: describe(membership, contract) });
      }
      // Past the minimum, there is nothing to wait for: cancel instead.
      if (cancellationPolicy(contract).reason !== 'minimum_term') {
        return json({
          ok: false,
          error: 'cannot_request',
          httpStatus: 409,
          membership: describe(membership, contract),
        });
      }
      const endsOn = minimumTermEndsOn(contract);
      await recordCancelRequest(pool, membership.id, endsOn);
      console.log(
        `[membership] ${customer.shop}: ${customer.shopifyCustomerId} asked to cancel ${contract.id}` +
          ` at the end of the minimum, ${endsOn?.toISOString() ?? 'date unknown'}`,
      );
      return json({
        ok: true,
        membership: describe({ ...membership, cancelRequestedAt: new Date(), cancelEndsOn: endsOn }, contract),
      });
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
