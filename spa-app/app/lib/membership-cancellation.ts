import {
  closeLapsedCancellation,
  listLapsedCancellations,
  membershipStatusFromContract,
  type Queryable,
} from './db.ts';
import { syncMemberTags, type AdminClient } from './membership-provisioning.ts';
import type { MembershipWindow } from './allowance.ts';
import { termFromPlanName, tierFromNames } from './membership-tiers.ts';

/**
 * A member cancelling their own membership, from the Wig Closet.
 *
 * Two rules, both enforced here and nowhere else:
 *
 * 1. The minimum commitment. Monthly plans carry `minCycles: 3`, and Shopify
 *    honours minCycles only in its own subscription UI — an API cancel goes
 *    straight through. So a member may cancel once they have paid that many
 *    cycles, and not before. Annual plans have a minimum of one, which the
 *    checkout already paid.
 *
 * 2. What a cancellation ends. `subscriptionContractCancel` ends the contract
 *    at once; there is no "at the end of the period" flag. Cancelling at once
 *    is right for the money — nothing more can be charged — but wrong for what
 *    was already paid for: an annual member cancelling in month two would lose
 *    ten months of Rejuvenations and member pricing they bought. So the
 *    contract is cancelled now and the membership is held open until the date
 *    it was paid through (`access_until`), after which the daily job closes it.
 *
 * A cancellation Tia makes in Shopify admin sets no `access_until`, so it still
 * ends everything at once, exactly as before.
 */

/** A contract as read back for the member, from the Admin API. */
export interface MemberContract {
  id: string;
  status: string;
  createdAt: Date;
  /** The date the member has paid through. Managed by this app. */
  nextBillingDate: Date | null;
  customerId: string | null;
  variantTitle: string | null;
  sellingPlanName: string | null;
  productTitle: string | null;
  billingPolicy: {
    interval: string;
    intervalCount: number;
    minCycles: number | null;
  } | null;
  /** Successful renewals, not counting the checkout that created the contract. */
  successfulRenewals: number;
}

export type CancelBlock =
  /** Under the minimum commitment; `cancellableFrom` says when that ends. */
  | 'minimum_term'
  /** Already cancelled, paused, failed — nothing for the member to cancel. */
  | 'not_active';

export interface CancellationPolicy {
  /** The plan name, as the member bought it. */
  planName: string | null;
  /** Billing cycles paid so far, the checkout included. */
  paidCycles: number;
  minCycles: number;
  canCancel: boolean;
  reason: CancelBlock | null;
  /**
   * When the member can cancel: the date of the charge that completes the
   * minimum. Null once they are past it.
   */
  cancellableFrom: Date | null;
}

/**
 * The contract's billing interval as a number of months.
 *
 * Every Wig Spa plan bills in months or years. Anything else returns null
 * rather than a guess, and the minimum date is then left unsaid.
 */
export function intervalMonths(policy: MemberContract['billingPolicy']): number | null {
  if (!policy) return null;
  const count = policy.intervalCount || 1;
  switch (policy.interval.toUpperCase()) {
    case 'MONTH':
      return count;
    case 'YEAR':
      return count * 12;
    default:
      return null;
  }
}

/** Calendar months later, held to the last day when the month is shorter. */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/**
 * The minimum a contract must pay before it can be cancelled.
 *
 * The contract's own billing policy first — Shopify fixed it at checkout, so it
 * is what the member agreed to even if the plan has changed since. Then the
 * term the plan name matches. Then one, which is what a prepaid legacy plan
 * always meant.
 */
export function minimumCycles(contract: MemberContract): number {
  const fromContract = contract.billingPolicy?.minCycles;
  if (typeof fromContract === 'number' && fromContract > 0) return fromContract;

  const tier = tierFromNames(contract.variantTitle, contract.sellingPlanName, contract.productTitle);
  const term = tier ? termFromPlanName(tier, contract.sellingPlanName) : undefined;
  return term?.minCycles ?? 1;
}

export function cancellationPolicy(contract: MemberContract): CancellationPolicy {
  // The checkout that created the contract is the first paid cycle.
  const paidCycles = 1 + contract.successfulRenewals;
  const minCycles = minimumCycles(contract);
  const base = { planName: contract.sellingPlanName, paidCycles, minCycles };

  if (contract.status.toUpperCase() !== 'ACTIVE') {
    return { ...base, canCancel: false, reason: 'not_active', cancellableFrom: null };
  }

  if (paidCycles >= minCycles) {
    return { ...base, canCancel: true, reason: null, cancellableFrom: null };
  }

  // Cycle n is charged (n - 1) intervals after the contract began.
  const months = intervalMonths(contract.billingPolicy);
  return {
    ...base,
    canCancel: false,
    reason: 'minimum_term',
    cancellableFrom: months === null ? null : addMonths(contract.createdAt, (minCycles - 1) * months),
  };
}

/**
 * A membership's status, given what Shopify says about its contract and how
 * long the member has paid for.
 *
 * A contract the member cancelled is still an active membership until the date
 * it was paid through. Every other status passes through unchanged: a paused
 * or failed contract has not been paid for, whatever the date.
 */
export function membershipStatus(
  contractStatus: string,
  accessUntil: Date | null,
  now: Date = new Date(),
): MembershipWindow['status'] {
  const status = membershipStatusFromContract(contractStatus);
  if (status === 'cancelled' && accessUntil && accessUntil.getTime() > now.getTime()) {
    return 'active';
  }
  return status;
}

/**
 * How long a member keeps their membership after cancelling: until the next
 * charge would have fallen. Never in the past — a contract whose billing date
 * has already gone by has nothing left to hold open.
 */
export function accessUntilAfterCancel(contract: MemberContract, now: Date = new Date()): Date | null {
  const until = contract.nextBillingDate;
  return until && until.getTime() > now.getTime() ? until : null;
}

// ─── Admin API ──────────────────────────────────────────────────────────────

/** Renewals beyond this are not counted; no plan has a minimum anywhere near. */
const BILLING_ATTEMPTS_READ = 100;

/**
 * Read a contract the way the cancel rules need it.
 *
 * Paid cycles are counted from billing attempts rather than orders: with
 * read_orders the app can only see the last 60 days of orders, so a member in
 * month three would have their first payment fall out of view. Billing
 * attempts belong to the app and carry no such limit. The checkout itself is
 * not a billing attempt — it is counted by cancellationPolicy.
 */
export async function readMemberContract(admin: AdminClient, contractId: string): Promise<MemberContract | null> {
  const response = await admin.graphql(
    `#graphql
      query MemberContract($id: ID!, $attempts: Int!) {
        subscriptionContract(id: $id) {
          id
          status
          createdAt
          nextBillingDate
          customer { id }
          billingPolicy { interval intervalCount minCycles }
          lines(first: 1) {
            nodes { title variantTitle sellingPlanName }
          }
          billingAttempts(first: $attempts) {
            nodes { ready errorCode }
          }
        }
      }`,
    { variables: { id: contractId, attempts: BILLING_ATTEMPTS_READ } },
  );
  const body: any = await response.json();
  if (body.errors?.length) {
    throw new Error(`reading contract ${contractId} failed: ${body.errors.map((e: any) => e.message).join('; ')}`);
  }

  const contract = body.data?.subscriptionContract;
  if (!contract) return null;

  const line = contract.lines?.nodes?.[0];
  const attempts: any[] = contract.billingAttempts?.nodes ?? [];

  return {
    id: contract.id,
    status: contract.status,
    createdAt: new Date(contract.createdAt),
    nextBillingDate: contract.nextBillingDate ? new Date(contract.nextBillingDate) : null,
    customerId: contract.customer?.id ?? null,
    variantTitle: line?.variantTitle ?? null,
    sellingPlanName: line?.sellingPlanName ?? null,
    productTitle: line?.title ?? null,
    billingPolicy: contract.billingPolicy
      ? {
          interval: contract.billingPolicy.interval,
          intervalCount: contract.billingPolicy.intervalCount,
          minCycles: contract.billingPolicy.minCycles ?? null,
        }
      : null,
    // A finished attempt with no error is a charge that went through.
    successfulRenewals: attempts.filter((attempt) => attempt.ready && !attempt.errorCode).length,
  };
}

export async function cancelContract(admin: AdminClient, contractId: string): Promise<void> {
  const response = await admin.graphql(
    `#graphql
      mutation CancelMemberContract($id: ID!) {
        subscriptionContractCancel(subscriptionContractId: $id) {
          contract { id status }
          userErrors { field message }
        }
      }`,
    { variables: { id: contractId } },
  );
  const body: any = await response.json();
  if (body.errors?.length) {
    throw new Error(`cancelling ${contractId} failed: ${body.errors.map((e: any) => e.message).join('; ')}`);
  }
  const userErrors = body.data?.subscriptionContractCancel?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(
      `cancelling ${contractId} rejected: ${userErrors.map((e: any) => `${JSON.stringify(e.field)} ${e.message}`).join('; ')}`,
    );
  }
}

// ─── The daily job ──────────────────────────────────────────────────────────

export interface LapsedRunResult {
  closed: string[];
  failed: Array<{ membershipId: string; error: string }>;
}

/**
 * End every held-open membership whose paid-through date has passed.
 *
 * Tags first, then the row: if Shopify cannot be reached the membership stays
 * open and the next run tries again, rather than closing it here while the
 * member keeps their pricing in the store. One member's failure does not stop
 * the rest.
 */
export async function endLapsedMemberships(
  db: Queryable,
  adminFor: (shop: string) => Promise<AdminClient>,
  now: Date = new Date(),
): Promise<LapsedRunResult> {
  const result: LapsedRunResult = { closed: [], failed: [] };
  for (const lapsed of await listLapsedCancellations(db, now)) {
    try {
      const admin = await adminFor(lapsed.shop);
      await syncMemberTags(admin, { customerId: lapsed.shopifyCustomerId, tierId: null, active: false });
      if (await closeLapsedCancellation(db, lapsed.membershipId)) result.closed.push(lapsed.membershipId);
    } catch (error) {
      result.failed.push({
        membershipId: lapsed.membershipId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
