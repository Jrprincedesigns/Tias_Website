import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessUntilAfterCancel,
  addMonths,
  cancellationPolicy,
  membershipStatus,
  type MemberContract,
} from '../app/lib/membership-cancellation.ts';

/**
 * Shopify does not enforce minCycles when an app cancels a contract, so these
 * are the only thing standing between a monthly member and taking the discount
 * for a month and leaving.
 */

const STARTED = new Date('2026-09-15T12:00:00Z');

function contract(overrides: Partial<MemberContract> = {}): MemberContract {
  return {
    id: 'gid://shopify/SubscriptionContract/1',
    status: 'ACTIVE',
    createdAt: STARTED,
    nextBillingDate: new Date('2026-10-15T12:00:00Z'),
    customerId: 'gid://shopify/Customer/7401',
    variantTitle: 'Essential Care',
    sellingPlanName: 'Monthly (3-month minimum)',
    productTitle: 'The Wig Spa Membership',
    billingPolicy: { interval: 'MONTH', intervalCount: 1, minCycles: 3 },
    successfulRenewals: 0,
    ...overrides,
  };
}

test('a monthly member after one payment cannot cancel, and is told when they can', () => {
  const policy = cancellationPolicy(contract());
  assert.equal(policy.canCancel, false);
  assert.equal(policy.reason, 'minimum_term');
  assert.equal(policy.paidCycles, 1);
  assert.equal(policy.minCycles, 3);
  // The third payment falls two months after the first.
  assert.equal(policy.cancellableFrom?.toISOString(), '2026-11-15T12:00:00.000Z');
});

test('a monthly member after two payments still cannot', () => {
  const policy = cancellationPolicy(contract({ successfulRenewals: 1 }));
  assert.equal(policy.canCancel, false);
  assert.equal(policy.paidCycles, 2);
});

test('a monthly member can cancel once the third payment has gone through', () => {
  const policy = cancellationPolicy(contract({ successfulRenewals: 2 }));
  assert.equal(policy.canCancel, true);
  assert.equal(policy.reason, null);
  assert.equal(policy.cancellableFrom, null);
});

test('time passing does not count as paying: the minimum is payments, not months', () => {
  // Five months in, but the renewals failed or never ran.
  const policy = cancellationPolicy(contract({ createdAt: new Date('2026-05-15T12:00:00Z') }));
  assert.equal(policy.canCancel, false);
  assert.equal(policy.reason, 'minimum_term');
});

test('an annual member can cancel straight away — the year is already paid', () => {
  const policy = cancellationPolicy(contract({
    sellingPlanName: 'Annual',
    billingPolicy: { interval: 'YEAR', intervalCount: 1, minCycles: 1 },
  }));
  assert.equal(policy.canCancel, true);
});

test("the contract's own minimum wins over today's plan definition", () => {
  // A member who bought under a stricter plan keeps the terms they agreed to.
  const policy = cancellationPolicy(contract({
    billingPolicy: { interval: 'MONTH', intervalCount: 1, minCycles: 6 },
    successfulRenewals: 2,
  }));
  assert.equal(policy.canCancel, false);
  assert.equal(policy.minCycles, 6);
});

test('a contract with no minimum on it falls back to the plan it matches', () => {
  const policy = cancellationPolicy(contract({
    billingPolicy: { interval: 'MONTH', intervalCount: 1, minCycles: null },
  }));
  assert.equal(policy.minCycles, 3);
  assert.equal(policy.canCancel, false);
});

test('a legacy plan that matches nothing has no minimum', () => {
  const policy = cancellationPolicy(contract({
    variantTitle: 'Founding',
    sellingPlanName: 'Every 12 months',
    billingPolicy: { interval: 'YEAR', intervalCount: 1, minCycles: null },
  }));
  assert.equal(policy.minCycles, 1);
  assert.equal(policy.canCancel, true);
});

test('only an active contract can be cancelled', () => {
  for (const status of ['CANCELLED', 'PAUSED', 'FAILED', 'EXPIRED']) {
    const policy = cancellationPolicy(contract({ status, successfulRenewals: 5 }));
    assert.equal(policy.canCancel, false, status);
    assert.equal(policy.reason, 'not_active', status);
  }
});

test('month arithmetic holds to the end of a shorter month', () => {
  assert.equal(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString(), '2026-02-28T00:00:00.000Z');
  assert.equal(addMonths(new Date('2026-11-30T00:00:00Z'), 2).toISOString(), '2027-01-30T00:00:00.000Z');
  assert.equal(addMonths(new Date('2026-03-15T00:00:00Z'), 0).toISOString(), '2026-03-15T00:00:00.000Z');
});

test('a cancelled contract is still an active membership until the paid-through date', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  assert.equal(membershipStatus('CANCELLED', new Date('2026-10-15T00:00:00Z'), now), 'active');
  assert.equal(membershipStatus('CANCELLED', new Date('2026-09-30T00:00:00Z'), now), 'cancelled');
  // Cancelled in admin: nothing held open.
  assert.equal(membershipStatus('CANCELLED', null, now), 'cancelled');
});

test('the paid-through date never holds open a paused or failed contract', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  const later = new Date('2026-12-01T00:00:00Z');
  assert.equal(membershipStatus('PAUSED', later, now), 'paused');
  assert.equal(membershipStatus('FAILED', later, now), 'past_due');
  assert.equal(membershipStatus('ACTIVE', later, now), 'active');
});

test('benefits run to the next billing date, and not at all when that has passed', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  assert.equal(accessUntilAfterCancel(contract(), now)?.toISOString(), '2026-10-15T12:00:00.000Z');
  assert.equal(accessUntilAfterCancel(contract({ nextBillingDate: new Date('2026-09-01T00:00:00Z') }), now), null);
  assert.equal(accessUntilAfterCancel(contract({ nextBillingDate: null }), now), null);
});
