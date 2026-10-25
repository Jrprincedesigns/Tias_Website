import {
  claimBillingAttempt,
  findBillingAttempt,
  listBillingAttempts,
  listRenewalCandidates,
  listShopsWithOfflineSessions,
  recordMembershipEvent,
  releaseBillingAttempt,
  resolveBillingAttempt,
  setBillingAttemptShopifyId,
  setMembershipNextBillingAt,
  type BillingAttemptRow,
  type Transactable,
} from './db.ts';
import { sendAlert } from './alerts.ts';
import { addMonths, cancelContract, intervalMonths } from './membership-cancellation.ts';
import type { AdminClient } from './membership-provisioning.ts';

/**
 * Charging membership renewals.
 *
 * The app owns its subscription contracts, and Shopify bills an app-owned
 * contract only when the app asks. Nothing else will: the "Next order in 31
 * days" in admin is a date, not a schedule. So once a day this charges every
 * active membership whose billing cycle has come due.
 *
 * ─── Which API ──────────────────────────────────────────────────────────────
 *
 * `subscriptionBillingCycleCharge`, not `subscriptionBillingAttemptCreate`.
 * Shopify works out the billing cycles from the contract's billing policy —
 * monthly, or every 12 months for Annual — and tracks each one as BILLED or
 * UNBILLED. The cycle charge allows a single successful charge per cycle, and
 * refuses a cycle more than 24 hours before it is due. So the schedule lives
 * in Shopify, and the worst a mistake here can do is try to charge a cycle
 * that is already paid, which Shopify turns down.
 *
 * What Shopify does not do is move the contract's `nextBillingDate` — that
 * field is "managed by the apps". After every successful charge this moves it
 * to the next cycle's date, which is what admin shows, what the closet's
 * cancellation reads as the date a member has paid through, and what the
 * daily job uses to skip members who are paid up.
 *
 * ─── Never twice ────────────────────────────────────────────────────────────
 *
 * The cycle charge takes no idempotency key, so the app keeps its own: every
 * charge is claimed in `billing_attempts` under contract + cycle + attempt
 * number before Shopify is asked, and only the run that wrote the claim sends
 * it. Two overlapping runs work out the same attempt number, and one loses.
 *
 * ─── When a charge fails ────────────────────────────────────────────────────
 *
 * Retried 3 and 7 days after the first failure. If the third charge fails too,
 * the contract is cancelled. The contract webhook then ends the membership and
 * takes the member tags off, as for any cancellation made in admin. Until
 * then the membership stays active.
 */

/** Days after the first failure on which a charge is retried. */
export const RETRY_AFTER_DAYS = [3, 7] as const;

/** The charge on the due date, and one per retry. */
export const MAX_ATTEMPTS = 1 + RETRY_AFTER_DAYS.length;

/**
 * A charge sent with nothing heard back after this long is taken to have gone
 * nowhere. Shopify processes charges within minutes and retries its webhooks
 * for 48 hours, so this happens only if the request itself was lost. Charging
 * the cycle again is safe: Shopify takes one successful charge per cycle.
 */
export const UNRESOLVED_AFTER_HOURS = 24;

/** How far back to look for a cycle still unpaid. Dunning is over in a week. */
const LOOKBACK_DAYS = 60;

const DAY_MS = 86_400_000;

/**
 * The key a charge is claimed under: one contract, one cycle, one attempt.
 * Deterministic, so every run that decides on the same charge names it the
 * same way.
 */
export function renewalIdempotencyKey(contractId: string, cycleIndex: number, attemptNumber: number): string {
  const id = contractId.split('/').pop();
  return `wig-spa-renewal:${id}:cycle-${cycleIndex}:attempt-${attemptNumber}`;
}

/** One of Shopify's billing cycles for a contract. */
export interface BillingCycle {
  cycleIndex: number;
  expectedAt: Date;
  status: 'BILLED' | 'UNBILLED';
  skipped: boolean;
}

/** A contract as the billing job needs it. */
export interface RenewalContract {
  id: string;
  status: string;
  createdAt: Date;
  nextBillingDate: Date | null;
  billingPolicy: { interval: string; intervalCount: number } | null;
  cycles: BillingCycle[];
}

/**
 * The earliest billing cycle owed for, or null when nothing is.
 *
 * Owed means unpaid, not skipped, and its date has come. A cycle dated before
 * the first renewal is never owed — the member paid for that at checkout — so
 * one dated earlier than a billing interval after the contract began is left
 * alone, as is every cycle of a contract whose interval is not months or
 * years. That should never match anything; it is here because charging the
 * checkout period a second time is the one mistake that would cost a member.
 */
export function dueCycle(contract: RenewalContract, now: Date = new Date()): BillingCycle | null {
  const months = intervalMonths(contract.billingPolicy ? { ...contract.billingPolicy, minCycles: null } : null);
  if (months === null) return null;
  // A day of slack either side: the cycle date and the contract's creation
  // time are not always to the second a whole number of months apart.
  const firstRenewal = addMonths(contract.createdAt, months).getTime() - DAY_MS;

  const owed = contract.cycles
    .filter((cycle) => cycle.status === 'UNBILLED' && !cycle.skipped)
    .filter((cycle) => cycle.expectedAt.getTime() <= now.getTime())
    .filter((cycle) => cycle.expectedAt.getTime() >= firstRenewal)
    .sort((a, b) => a.cycleIndex - b.cycleIndex);
  return owed[0] ?? null;
}

/** An attempt as the rules see it. */
export type AttemptRecord = Pick<BillingAttemptRow, 'attemptNumber' | 'status' | 'requestedAt' | 'resolvedAt'>;

export type RenewalStep =
  /** Send this charge. */
  | { kind: 'charge'; attemptNumber: number }
  /** Paid. */
  | { kind: 'paid' }
  /** A charge is out and its outcome not yet in. */
  | { kind: 'in_flight'; attemptNumber: number }
  /** A charge went out and nothing ever came back; release it and charge again. */
  | { kind: 'unresolved'; attemptNumber: number }
  /** Failed; the next retry is due then. */
  | { kind: 'retry_later'; retryAt: Date }
  /** Every attempt failed. */
  | { kind: 'give_up' };

/**
 * When a cycle that has failed `failures` times is next retried, or null once
 * there are no retries left.
 */
export function retryAt(firstFailureAt: Date, failures: number): Date | null {
  const days = RETRY_AFTER_DAYS[failures - 1];
  return days === undefined ? null : new Date(firstFailureAt.getTime() + days * DAY_MS);
}

/**
 * What to do about one owed cycle, given the charges already asked for on it.
 *
 * A challenged charge — the bank wants the member to confirm it — counts as a
 * failure for the schedule: the cycle is still unpaid, and retrying is safe,
 * because if the member does confirm it Shopify takes no second payment for
 * the cycle.
 */
export function renewalStep(attempts: AttemptRecord[], now: Date = new Date()): RenewalStep {
  if (attempts.some((attempt) => attempt.status === 'succeeded')) return { kind: 'paid' };

  const open = attempts.find((attempt) => attempt.status === 'requested');
  if (open) {
    const age = now.getTime() - open.requestedAt.getTime();
    return age >= UNRESOLVED_AFTER_HOURS * 3_600_000
      ? { kind: 'unresolved', attemptNumber: open.attemptNumber }
      : { kind: 'in_flight', attemptNumber: open.attemptNumber };
  }

  if (attempts.length === 0) return { kind: 'charge', attemptNumber: 1 };
  if (attempts.length >= MAX_ATTEMPTS) return { kind: 'give_up' };

  const sorted = [...attempts].sort((a, b) => a.attemptNumber - b.attemptNumber);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const next = retryAt(first.resolvedAt ?? first.requestedAt, attempts.length)!;
  if (now.getTime() < next.getTime()) return { kind: 'retry_later', retryAt: next };
  return { kind: 'charge', attemptNumber: last.attemptNumber + 1 };
}

// ─── Admin API ──────────────────────────────────────────────────────────────

async function graphql(admin: AdminClient, what: string, query: string, variables: Record<string, unknown>) {
  const response = await admin.graphql(query, { variables });
  const body: any = await response.json();
  if (body.errors?.length) {
    throw new ShopifyRefused(`${what}: ${body.errors.map((e: any) => e.message).join('; ')}`);
  }
  return body.data;
}

/**
 * Shopify answered and said no: nothing was done. Distinct from a request
 * that never got an answer, after which nobody knows.
 */
export class ShopifyRefused extends Error {
  readonly codes: string[];

  constructor(message: string, codes: string[] = []) {
    super(message);
    this.name = 'ShopifyRefused';
    this.codes = codes;
  }
}

function userErrorsMessage(errors: any[]): string {
  return errors.map((e) => `${e.code ?? JSON.stringify(e.field)} ${e.message}`).join('; ');
}

export async function readRenewalContract(
  admin: AdminClient,
  contractId: string,
  now: Date = new Date(),
): Promise<RenewalContract | null> {
  const data = await graphql(
    admin,
    `reading billing cycles for ${contractId}`,
    `#graphql
      query RenewalContract($id: ID!, $from: DateTime!, $to: DateTime!) {
        subscriptionContract(id: $id) {
          id
          status
          createdAt
          nextBillingDate
          billingPolicy { interval intervalCount }
        }
        subscriptionBillingCycles(
          contractId: $id
          first: 50
          billingCyclesDateRangeSelector: { startDate: $from, endDate: $to }
        ) {
          nodes { cycleIndex billingAttemptExpectedDate status skipped }
        }
      }`,
    {
      id: contractId,
      from: new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS).toISOString(),
      to: new Date(now.getTime() + DAY_MS).toISOString(),
    },
  );
  const contract = data?.subscriptionContract;
  if (!contract) return null;
  return {
    id: contract.id,
    status: contract.status,
    createdAt: new Date(contract.createdAt),
    nextBillingDate: contract.nextBillingDate ? new Date(contract.nextBillingDate) : null,
    billingPolicy: contract.billingPolicy ?? null,
    cycles: (data?.subscriptionBillingCycles?.nodes ?? []).map((cycle: any) => ({
      cycleIndex: cycle.cycleIndex,
      expectedAt: new Date(cycle.billingAttemptExpectedDate),
      status: cycle.status,
      skipped: Boolean(cycle.skipped),
    })),
  };
}

/** Ask Shopify to charge one cycle. Returns the billing attempt it created. */
export async function chargeBillingCycle(
  admin: AdminClient,
  contractId: string,
  cycleIndex: number,
): Promise<{ attemptId: string | null }> {
  const data = await graphql(
    admin,
    `charging ${contractId} cycle ${cycleIndex}`,
    `#graphql
      mutation ChargeRenewal($id: ID!, $index: Int!) {
        subscriptionBillingCycleCharge(
          subscriptionContractId: $id
          billingCycleSelector: { index: $index }
        ) {
          subscriptionBillingAttempt { id }
          userErrors { field message code }
        }
      }`,
    { id: contractId, index: cycleIndex },
  );
  const payload = data?.subscriptionBillingCycleCharge;
  const userErrors: any[] = payload?.userErrors ?? [];
  if (userErrors.length) {
    throw new ShopifyRefused(
      `charging ${contractId} cycle ${cycleIndex} rejected: ${userErrorsMessage(userErrors)}`,
      userErrors.map((e) => e.code).filter(Boolean),
    );
  }
  return { attemptId: payload?.subscriptionBillingAttempt?.id ?? null };
}

/** The date the cycle after `cycleIndex` is due, from Shopify's schedule. */
export async function nextCycleDate(
  admin: AdminClient,
  contractId: string,
  cycleIndex: number,
): Promise<Date | null> {
  const data = await graphql(
    admin,
    `reading the cycle after ${cycleIndex} for ${contractId}`,
    `#graphql
      query NextRenewalCycle($id: ID!, $index: Int!) {
        subscriptionBillingCycles(
          contractId: $id
          first: 1
          billingCyclesIndexRangeSelector: { startIndex: $index, endIndex: $index }
        ) {
          nodes { cycleIndex billingAttemptExpectedDate }
        }
      }`,
    { id: contractId, index: cycleIndex + 1 },
  );
  const cycle = data?.subscriptionBillingCycles?.nodes?.[0];
  return cycle ? new Date(cycle.billingAttemptExpectedDate) : null;
}

export async function setContractNextBillingDate(admin: AdminClient, contractId: string, date: Date): Promise<void> {
  const data = await graphql(
    admin,
    `moving ${contractId}'s next billing date`,
    `#graphql
      mutation SetRenewalDate($id: ID!, $date: DateTime!) {
        subscriptionContractSetNextBillingDate(contractId: $id, date: $date) {
          contract { id nextBillingDate }
          userErrors { field message }
        }
      }`,
    { id: contractId, date: date.toISOString() },
  );
  const userErrors: any[] = data?.subscriptionContractSetNextBillingDate?.userErrors ?? [];
  if (userErrors.length) {
    throw new ShopifyRefused(`moving ${contractId}'s next billing date rejected: ${userErrorsMessage(userErrors)}`);
  }
}

// ─── The daily job ──────────────────────────────────────────────────────────

export interface RenewalRunResult {
  /** Charges sent: contract, cycle and attempt. */
  charged: Array<{ contractId: string; cycleIndex: number; attemptNumber: number }>;
  /** Contracts cancelled after their last retry failed. */
  cancelled: string[];
  failed: Array<{ shop: string; contractId: string | null; error: string }>;
}

/**
 * Charge every renewal that has come due, in every store the app has an
 * offline session for. One contract's trouble does not stop the rest.
 */
export async function chargeDueRenewals(
  pool: Transactable,
  adminFor: (shop: string) => Promise<AdminClient>,
  now: Date = new Date(),
): Promise<RenewalRunResult> {
  const result: RenewalRunResult = { charged: [], cancelled: [], failed: [] };

  for (const shop of await listShopsWithOfflineSessions(pool)) {
    const candidates = await listRenewalCandidates(pool, shop, now);
    if (candidates.length === 0) continue;

    let admin: AdminClient;
    try {
      admin = await adminFor(shop);
    } catch (error) {
      result.failed.push({ shop, contractId: null, error: errorMessage(error) });
      continue;
    }

    for (const candidate of candidates) {
      try {
        await renewOne(pool, admin, shop, candidate.membershipId, candidate.shopifyContractId, now, result);
      } catch (error) {
        result.failed.push({ shop, contractId: candidate.shopifyContractId, error: errorMessage(error) });
      }
    }
  }
  return result;
}

async function renewOne(
  pool: Transactable,
  admin: AdminClient,
  shop: string,
  membershipId: string,
  contractId: string,
  now: Date,
  result: RenewalRunResult,
): Promise<void> {
  const contract = await readRenewalContract(admin, contractId, now);
  // Paused, cancelled or failed in Shopify: the contract webhook moves the
  // membership off active, and until then there is nothing to charge.
  if (!contract || contract.status.toUpperCase() !== 'ACTIVE') return;

  const cycle = dueCycle(contract, now);
  if (!cycle) {
    await repairNextBillingDate(pool, admin, membershipId, contract, now);
    return;
  }

  const attempts = await listBillingAttempts(pool, contractId, cycle.cycleIndex);
  const step = renewalStep(attempts, now);

  switch (step.kind) {
    case 'charge': {
      const key = renewalIdempotencyKey(contractId, cycle.cycleIndex, step.attemptNumber);
      const claimed = await claimBillingAttempt(pool, {
        membershipId,
        shop,
        shopifyContractId: contractId,
        cycleIndex: cycle.cycleIndex,
        attemptNumber: step.attemptNumber,
        idempotencyKey: key,
      }, now);
      // Another run got here first and is sending this charge.
      if (!claimed) return;

      let attemptId: string | null;
      try {
        ({ attemptId } = await chargeBillingCycle(admin, contractId, cycle.cycleIndex));
      } catch (error) {
        // Refused outright: nothing was charged, so the claim goes and the next
        // run asks again. No answer at all: the charge may be on its way, so
        // the claim stays and its webhook — or, failing that, the
        // unresolved-after rule — settles it.
        if (error instanceof ShopifyRefused) await releaseBillingAttempt(pool, key);
        throw error;
      }
      if (attemptId) await setBillingAttemptShopifyId(pool, key, attemptId);
      result.charged.push({ contractId, cycleIndex: cycle.cycleIndex, attemptNumber: step.attemptNumber });
      return;
    }

    case 'unresolved': {
      const key = renewalIdempotencyKey(contractId, cycle.cycleIndex, step.attemptNumber);
      if (await releaseBillingAttempt(pool, key)) {
        await recordMembershipEvent(pool, membershipId, 'membership_renewal_unresolved', {
          contract: contractId,
          cycleIndex: cycle.cycleIndex,
          attempt: step.attemptNumber,
        });
        console.warn(
          `[renewals] ${contractId} cycle ${cycle.cycleIndex} attempt ${step.attemptNumber}: ` +
            `no outcome after ${UNRESOLVED_AFTER_HOURS}h, released to charge again`,
        );
      }
      return;
    }

    case 'give_up':
      // The failure webhook normally does this. Here only if that failed.
      await cancelForNonPayment(pool, admin, membershipId, contractId, cycle.cycleIndex);
      result.cancelled.push(contractId);
      return;

    case 'paid':
    case 'in_flight':
    case 'retry_later':
      return;
  }
}

/**
 * Nothing is owed but the contract's next billing date has passed: a renewal
 * went through and moving the date afterwards did not. Put it right, or the
 * closet would tell a member their membership ends on a day already gone.
 */
async function repairNextBillingDate(
  pool: Transactable,
  admin: AdminClient,
  membershipId: string,
  contract: RenewalContract,
  now: Date,
): Promise<void> {
  if (!contract.nextBillingDate || contract.nextBillingDate.getTime() > now.getTime()) return;
  const lastBilled = contract.cycles
    .filter((cycle) => cycle.status === 'BILLED')
    .sort((a, b) => b.cycleIndex - a.cycleIndex)[0];
  if (!lastBilled) return;
  await advanceNextBillingDate(pool, admin, membershipId, contract.id, lastBilled.cycleIndex);
}

async function advanceNextBillingDate(
  pool: Transactable,
  admin: AdminClient,
  membershipId: string,
  contractId: string,
  paidCycleIndex: number,
): Promise<Date | null> {
  const next = await nextCycleDate(admin, contractId, paidCycleIndex);
  if (!next) return null;
  await setContractNextBillingDate(admin, contractId, next);
  await setMembershipNextBillingAt(pool, membershipId, next);
  return next;
}

async function cancelForNonPayment(
  pool: Transactable,
  admin: AdminClient,
  membershipId: string,
  contractId: string,
  cycleIndex: number,
): Promise<void> {
  await cancelContract(admin, contractId);
  await recordMembershipEvent(pool, membershipId, 'membership_cancelled_nonpayment', {
    contract: contractId,
    cycleIndex,
    attempts: MAX_ATTEMPTS,
  });
  await sendAlert({
    event: 'membership_cancelled_nonpayment',
    summary:
      `A Wig Spa membership was cancelled after ${MAX_ATTEMPTS} failed renewal charges ` +
      `(${contractId}). Their membership has ended; they would need to sign up again.`,
    detail: { contractId, cycleIndex },
  });
}

// ─── Billing attempt webhooks ───────────────────────────────────────────────

/** What a subscription_billing_attempts/* webhook says, in Admin API ids. */
export interface BillingAttemptOutcome {
  attemptId: string | null;
  contractId: string | null;
  orderId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

function gid(type: string, apiId: unknown, numericId: unknown): string | null {
  if (typeof apiId === 'string' && apiId) return apiId;
  if (numericId !== null && numericId !== undefined && numericId !== '') return `gid://shopify/${type}/${numericId}`;
  return null;
}

export function billingAttemptOutcome(payload: any): BillingAttemptOutcome {
  return {
    attemptId: gid('SubscriptionBillingAttempt', payload?.admin_graphql_api_id, payload?.id),
    contractId: gid(
      'SubscriptionContract',
      payload?.admin_graphql_api_subscription_contract_id,
      payload?.subscription_contract_id,
    ),
    orderId: gid('Order', payload?.admin_graphql_api_order_id, payload?.order_id),
    errorCode: payload?.error_code ?? null,
    errorMessage: payload?.error_message ?? null,
  };
}

export type OutcomeHandled =
  /** Not a charge this app asked for. */
  | 'unknown'
  /** Already recorded by an earlier delivery. */
  | 'duplicate'
  | 'recorded';

/**
 * A renewal went through: record the payment against the membership, then
 * move the contract's next billing date to the next cycle.
 *
 * The date is moved on every delivery, not only the first, so a delivery that
 * recorded the payment but failed to reach Shopify is finished by the retry.
 */
export async function handleBillingSuccess(
  pool: Transactable,
  admin: AdminClient,
  outcome: BillingAttemptOutcome,
): Promise<OutcomeHandled> {
  const attempt = await findBillingAttempt(pool, {
    shopifyAttemptId: outcome.attemptId,
    shopifyContractId: outcome.contractId,
  });
  if (!attempt) return 'unknown';

  const recorded = await resolveBillingAttempt(pool, attempt, {
    status: 'succeeded',
    shopifyAttemptId: outcome.attemptId,
    shopifyOrderId: outcome.orderId,
    event: {
      kind: 'membership_renewed',
      payload: {
        contract: attempt.shopifyContractId,
        cycleIndex: attempt.cycleIndex,
        attempt: attempt.attemptNumber,
        billingAttempt: outcome.attemptId,
        order: outcome.orderId,
      },
    },
  });

  await advanceNextBillingDate(pool, admin, attempt.membershipId, attempt.shopifyContractId, attempt.cycleIndex);
  return recorded ? 'recorded' : 'duplicate';
}

/**
 * A renewal charge failed. Record it with when it will be retried; after the
 * last retry, cancel the contract.
 */
export async function handleBillingFailure(
  pool: Transactable,
  admin: AdminClient,
  outcome: BillingAttemptOutcome,
  now: Date = new Date(),
): Promise<OutcomeHandled> {
  return recordUnpaid(pool, admin, outcome, 'failed', now);
}

/**
 * The member's bank wants them to confirm the charge (3D Secure). The app has
 * no way to put that in front of them, so Tia is told; the cycle is retried on
 * the failure schedule meanwhile.
 */
export async function handleBillingChallenged(
  pool: Transactable,
  admin: AdminClient,
  outcome: BillingAttemptOutcome,
  now: Date = new Date(),
): Promise<OutcomeHandled> {
  return recordUnpaid(pool, admin, outcome, 'challenged', now);
}

async function recordUnpaid(
  pool: Transactable,
  admin: AdminClient,
  outcome: BillingAttemptOutcome,
  status: 'failed' | 'challenged',
  now: Date,
): Promise<OutcomeHandled> {
  const attempt = await findBillingAttempt(pool, {
    shopifyAttemptId: outcome.attemptId,
    shopifyContractId: outcome.contractId,
  });
  if (!attempt) return 'unknown';

  // The schedule as it stands once this outcome is counted.
  const earlier = (await listBillingAttempts(pool, attempt.shopifyContractId, attempt.cycleIndex)).filter(
    (other) => other.id !== attempt.id,
  );
  const counted: AttemptRecord[] = [
    ...earlier,
    { attemptNumber: attempt.attemptNumber, status, requestedAt: attempt.requestedAt, resolvedAt: now },
  ];
  const step = renewalStep(counted, now);
  const nextRetry = step.kind === 'retry_later' ? step.retryAt : null;

  const recorded = await resolveBillingAttempt(pool, attempt, {
    status,
    shopifyAttemptId: outcome.attemptId,
    errorCode: outcome.errorCode,
    errorMessage: outcome.errorMessage,
    event: {
      kind: status === 'challenged' ? 'membership_renewal_challenged' : 'membership_renewal_failed',
      payload: {
        contract: attempt.shopifyContractId,
        cycleIndex: attempt.cycleIndex,
        attempt: attempt.attemptNumber,
        billingAttempt: outcome.attemptId,
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
        retryAt: nextRetry?.toISOString() ?? null,
        final: step.kind === 'give_up',
      },
    },
  }, now);
  if (!recorded) return 'duplicate';

  if (step.kind === 'give_up') {
    await cancelForNonPayment(pool, admin, attempt.membershipId, attempt.shopifyContractId, attempt.cycleIndex);
  } else if (status === 'challenged') {
    await sendAlert({
      event: 'membership_renewal_challenged',
      summary:
        `A Wig Spa renewal needs the member to confirm the payment with their bank ` +
        `(${attempt.shopifyContractId}). It will be retried${nextRetry ? ` on ${nextRetry.toDateString()}` : ''}.`,
      detail: { contractId: attempt.shopifyContractId, cycleIndex: attempt.cycleIndex, attempt: attempt.attemptNumber },
    });
  }
  return 'recorded';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
