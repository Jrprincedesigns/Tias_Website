import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ATTEMPTS,
  billingAttemptOutcome,
  dueCycle,
  renewalIdempotencyKey,
  renewalStep,
  type AttemptRecord,
  type BillingCycle,
  type RenewalContract,
} from '../app/lib/renewal-billing.ts';

/**
 * Which renewal is owed, and what to do about it. These decide when a member's
 * card is charged, so the cases that matter most are the ones that must NOT
 * charge: a cycle already paid, one not yet due, and the period paid for at
 * checkout.
 */

const DAY = 86_400_000;
const STARTED = new Date('2026-10-25T15:00:00Z');

function cycle(cycleIndex: number, expectedAt: string, overrides: Partial<BillingCycle> = {}): BillingCycle {
  return { cycleIndex, expectedAt: new Date(expectedAt), status: 'UNBILLED', skipped: false, ...overrides };
}

function monthly(cycles: BillingCycle[], overrides: Partial<RenewalContract> = {}): RenewalContract {
  return {
    id: 'gid://shopify/SubscriptionContract/1',
    status: 'ACTIVE',
    createdAt: STARTED,
    nextBillingDate: new Date('2026-11-25T15:00:00Z'),
    billingPolicy: { interval: 'MONTH', intervalCount: 1 },
    cycles,
    ...overrides,
  };
}

function annual(cycles: BillingCycle[]): RenewalContract {
  return monthly(cycles, {
    nextBillingDate: new Date('2027-10-25T15:00:00Z'),
    billingPolicy: { interval: 'YEAR', intervalCount: 1 },
  });
}

// ─── dueCycle ───────────────────────────────────────────────────────────────

test('a monthly renewal is due on its date, not the day before', () => {
  const contract = monthly([cycle(1, '2026-11-25T15:00:00Z'), cycle(2, '2026-12-25T15:00:00Z')]);
  assert.equal(dueCycle(contract, new Date('2026-11-24T15:00:00Z')), null);
  assert.equal(dueCycle(contract, new Date('2026-11-25T15:00:00Z'))?.cycleIndex, 1);
});

test('a cycle already billed is never due again', () => {
  const contract = monthly([
    cycle(1, '2026-11-25T15:00:00Z', { status: 'BILLED' }),
    cycle(2, '2026-12-25T15:00:00Z'),
  ]);
  assert.equal(dueCycle(contract, new Date('2026-12-01T00:00:00Z')), null);
  assert.equal(dueCycle(contract, new Date('2026-12-25T16:00:00Z'))?.cycleIndex, 2);
});

test('a skipped cycle is not charged', () => {
  const contract = monthly([cycle(1, '2026-11-25T15:00:00Z', { skipped: true })]);
  assert.equal(dueCycle(contract, new Date('2026-11-26T00:00:00Z')), null);
});

test('the earliest unpaid cycle comes first, so a failing one is not jumped', () => {
  const contract = monthly([cycle(2, '2026-12-25T15:00:00Z'), cycle(1, '2026-11-25T15:00:00Z')]);
  assert.equal(dueCycle(contract, new Date('2026-12-26T00:00:00Z'))?.cycleIndex, 1);
});

test('nothing dated inside the period paid at checkout is ever charged', () => {
  // Were Shopify's first cycle dated at the contract's creation, charging it
  // would bill the member twice for their first month.
  const contract = monthly([cycle(1, STARTED.toISOString())]);
  assert.equal(dueCycle(contract, new Date(STARTED.getTime() + 10 * DAY)), null);
});

test('an annual membership renews after 12 months, not after one', () => {
  const contract = annual([cycle(1, '2027-10-25T15:00:00Z')]);
  assert.equal(dueCycle(contract, new Date('2026-11-26T00:00:00Z')), null);
  assert.equal(dueCycle(contract, new Date('2027-10-25T16:00:00Z'))?.cycleIndex, 1);
});

test('an annual contract never takes a monthly-dated charge', () => {
  // A cycle a month in is inside the year the member prepaid.
  const contract = annual([cycle(1, '2026-11-25T15:00:00Z')]);
  assert.equal(dueCycle(contract, new Date('2026-11-26T00:00:00Z')), null);
});

test('a contract billed on an interval that is not months or years is left alone', () => {
  const contract = monthly([cycle(1, '2026-11-01T15:00:00Z')], {
    billingPolicy: { interval: 'WEEK', intervalCount: 1 },
  });
  assert.equal(dueCycle(contract, new Date('2026-12-01T00:00:00Z')), null);
});

// ─── renewalStep ────────────────────────────────────────────────────────────

const DUE = new Date('2026-11-25T15:00:00Z');

function attempt(attemptNumber: number, status: AttemptRecord['status'], at: Date): AttemptRecord {
  return { attemptNumber, status, requestedAt: at, resolvedAt: status === 'requested' ? null : at };
}

test('the first charge goes out when nothing has been tried', () => {
  assert.deepEqual(renewalStep([], DUE), { kind: 'charge', attemptNumber: 1 });
});

test('a charge in flight is waited for, not sent again', () => {
  const step = renewalStep([attempt(1, 'requested', DUE)], new Date(DUE.getTime() + 3_600_000));
  assert.deepEqual(step, { kind: 'in_flight', attemptNumber: 1 });
});

test('a charge with no outcome after a day is released to be charged again', () => {
  const step = renewalStep([attempt(1, 'requested', DUE)], new Date(DUE.getTime() + DAY));
  assert.deepEqual(step, { kind: 'unresolved', attemptNumber: 1 });
});

test('a paid cycle is finished, whatever failed before it', () => {
  const step = renewalStep([attempt(1, 'failed', DUE), attempt(2, 'succeeded', new Date(DUE.getTime() + 3 * DAY))]);
  assert.deepEqual(step, { kind: 'paid' });
});

test('a failed charge is retried 3 days after the failure', () => {
  const failed = [attempt(1, 'failed', DUE)];
  const early = renewalStep(failed, new Date(DUE.getTime() + 3 * DAY - 1));
  assert.equal(early.kind, 'retry_later');
  assert.equal(early.kind === 'retry_later' && early.retryAt.toISOString(), new Date(DUE.getTime() + 3 * DAY).toISOString());
  assert.deepEqual(renewalStep(failed, new Date(DUE.getTime() + 3 * DAY)), { kind: 'charge', attemptNumber: 2 });
});

test('the second retry is 7 days after the first failure, not after the second', () => {
  const failed = [attempt(1, 'failed', DUE), attempt(2, 'failed', new Date(DUE.getTime() + 3 * DAY))];
  const early = renewalStep(failed, new Date(DUE.getTime() + 7 * DAY - 1));
  assert.equal(early.kind, 'retry_later');
  assert.deepEqual(renewalStep(failed, new Date(DUE.getTime() + 7 * DAY)), { kind: 'charge', attemptNumber: 3 });
});

test('after the third failure there are no more retries', () => {
  assert.equal(MAX_ATTEMPTS, 3);
  const failed = [
    attempt(1, 'failed', DUE),
    attempt(2, 'failed', new Date(DUE.getTime() + 3 * DAY)),
    attempt(3, 'failed', new Date(DUE.getTime() + 7 * DAY)),
  ];
  assert.deepEqual(renewalStep(failed, new Date(DUE.getTime() + 30 * DAY)), { kind: 'give_up' });
});

test('a charge the bank challenged counts as a failure for the schedule', () => {
  const step = renewalStep([attempt(1, 'challenged', DUE)], new Date(DUE.getTime() + 3 * DAY));
  assert.deepEqual(step, { kind: 'charge', attemptNumber: 2 });
});

// ─── Keys and payloads ──────────────────────────────────────────────────────

test('the idempotency key is the same every time for the same charge', () => {
  const key = renewalIdempotencyKey('gid://shopify/SubscriptionContract/123', 4, 2);
  assert.equal(key, 'wig-spa-renewal:123:cycle-4:attempt-2');
  assert.equal(renewalIdempotencyKey('gid://shopify/SubscriptionContract/123', 4, 2), key);
  assert.notEqual(renewalIdempotencyKey('gid://shopify/SubscriptionContract/123', 4, 3), key);
  assert.notEqual(renewalIdempotencyKey('gid://shopify/SubscriptionContract/123', 5, 2), key);
});

test('a billing attempt webhook is read in Admin API ids, from either spelling', () => {
  assert.deepEqual(
    billingAttemptOutcome({
      id: 55,
      subscription_contract_id: 123,
      order_id: 777,
      error_code: null,
      error_message: null,
    }),
    {
      attemptId: 'gid://shopify/SubscriptionBillingAttempt/55',
      contractId: 'gid://shopify/SubscriptionContract/123',
      orderId: 'gid://shopify/Order/777',
      errorCode: null,
      errorMessage: null,
    },
  );
  const failed = billingAttemptOutcome({
    admin_graphql_api_id: 'gid://shopify/SubscriptionBillingAttempt/56',
    admin_graphql_api_subscription_contract_id: 'gid://shopify/SubscriptionContract/123',
    order_id: null,
    error_code: 'insufficient_funds',
    error_message: 'Insufficient funds',
  });
  assert.equal(failed.attemptId, 'gid://shopify/SubscriptionBillingAttempt/56');
  assert.equal(failed.orderId, null);
  assert.equal(failed.errorCode, 'insufficient_funds');
});
