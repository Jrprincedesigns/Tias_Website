import test from 'node:test';
import assert from 'node:assert/strict';
import {
  balanceOf,
  assertDeltaDirection,
  decideCoverage,
  consumptionEntry,
  rolloverEntries,
  type LedgerEntry,
  type MembershipWindow,
} from '../app/lib/allowance.ts';

const activeMembership: MembershipWindow = {
  status: 'active',
  membershipYearStart: new Date('2026-01-01'),
  membershipYearEnd: new Date('2027-01-01'),
};

const granted = (n: number): LedgerEntry[] => [{ kind: 'grant', delta: n }];

test('balance is the sum of every delta', () => {
  assert.equal(balanceOf([]), 0);
  assert.equal(
    balanceOf([
      { kind: 'grant', delta: 4 },
      { kind: 'consumption', delta: -1, serviceRequestId: 'a' },
      { kind: 'consumption', delta: -1, serviceRequestId: 'b' },
    ]),
    2,
  );
});

test('a grant that subtracts is rejected', () => {
  assert.throws(() => assertDeltaDirection('grant', -2), /must add services/);
  assert.throws(() => assertDeltaDirection('rollover', 0), /must add services/);
});

test('a consumption that adds is rejected', () => {
  assert.throws(() => assertDeltaDirection('consumption', 3), /must subtract services/);
  assert.throws(() => assertDeltaDirection('expiry', 0), /must subtract services/);
});

test('a fractional delta is rejected', () => {
  assert.throws(() => assertDeltaDirection('grant', 1.5), /whole number/);
});

test('an adjustment of zero is rejected', () => {
  assert.throws(() => assertDeltaDirection('adjustment', 0), /changes nothing/);
});

test('an adjustment may go either direction', () => {
  assert.doesNotThrow(() => assertDeltaDirection('adjustment', 1));
  assert.doesNotThrow(() => assertDeltaDirection('adjustment', -1));
});

test('a member with services left is covered', () => {
  assert.deepEqual(
    decideCoverage({ membership: activeMembership, entries: granted(2), serviceRequestId: 'req-1' }),
    { covered: true },
  );
});

test('a non-member is not covered', () => {
  assert.deepEqual(
    decideCoverage({ membership: null, entries: [], serviceRequestId: 'req-1' }),
    { covered: false, reason: 'no_membership' },
  );
});

test('a past-due membership stops earning new coverage', () => {
  const pastDue: MembershipWindow = { ...activeMembership, status: 'past_due' };
  assert.deepEqual(
    decideCoverage({ membership: pastDue, entries: granted(4), serviceRequestId: 'req-1' }),
    { covered: false, reason: 'membership_inactive' },
  );
});

test('a cancelled membership stops earning new coverage', () => {
  const cancelled: MembershipWindow = { ...activeMembership, status: 'cancelled' };
  assert.deepEqual(
    decideCoverage({ membership: cancelled, entries: granted(4), serviceRequestId: 'req-1' }),
    { covered: false, reason: 'membership_inactive' },
  );
});

test('a spent allowance is not covered', () => {
  const entries: LedgerEntry[] = [
    { kind: 'grant', delta: 1 },
    { kind: 'consumption', delta: -1, serviceRequestId: 'req-0' },
  ];
  assert.deepEqual(
    decideCoverage({ membership: activeMembership, entries, serviceRequestId: 'req-1' }),
    { covered: false, reason: 'no_services_left' },
  );
});

test('the same request cannot be covered twice', () => {
  // The retry case: a request already consumed its service, and something
  // asks again. Without this the member pays once and we deduct twice.
  const entries: LedgerEntry[] = [
    { kind: 'grant', delta: 4 },
    { kind: 'consumption', delta: -1, serviceRequestId: 'req-1' },
  ];
  assert.deepEqual(
    decideCoverage({ membership: activeMembership, entries, serviceRequestId: 'req-1' }),
    { covered: false, reason: 'already_consumed' },
  );
});

test('consuming produces a single negative entry tied to the request', () => {
  const entry = consumptionEntry({
    membership: activeMembership,
    entries: granted(2),
    serviceRequestId: 'req-7',
  });
  assert.deepEqual(entry, { kind: 'consumption', delta: -1, serviceRequestId: 'req-7' });
});

test('consuming an uncovered service throws rather than writing nothing', () => {
  assert.throws(
    () => consumptionEntry({ membership: activeMembership, entries: granted(0), serviceRequestId: 'req-7' }),
    /not covered: no_services_left/,
  );
});

test('rollover carries what fits under the cap and forfeits the rest', () => {
  const entries = rolloverEntries({ balanceAtYearEnd: 3, maxRollover: 1 });
  assert.equal(balanceOf(entries), -2, 'net effect is losing two of the three');
  assert.equal(entries[0]?.kind, 'expiry');
  assert.equal(entries[0]?.delta, -3);
  assert.equal(entries[1]?.kind, 'rollover');
  assert.equal(entries[1]?.delta, 1);
  assert.match(entries[1]?.reason ?? '', /2 forfeited/);
});

test('rollover under the cap forfeits nothing', () => {
  const entries = rolloverEntries({ balanceAtYearEnd: 1, maxRollover: 2 });
  assert.equal(balanceOf(entries), 0, 'the single unused service survives the year boundary');
  assert.doesNotMatch(entries[1]?.reason ?? '', /forfeited/);
});

test('a zero cap expires everything and grants nothing', () => {
  const entries = rolloverEntries({ balanceAtYearEnd: 2, maxRollover: 0 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.kind, 'expiry');
  assert.equal(balanceOf(entries), -2);
});

test('a year that ended empty writes no entries at all', () => {
  assert.deepEqual(rolloverEntries({ balanceAtYearEnd: 0, maxRollover: 2 }), []);
});

test('an overdrawn balance writes no entries', () => {
  // Shouldn't happen, but writing a positive "expiry" for a negative balance
  // would silently hand out a free service.
  assert.deepEqual(rolloverEntries({ balanceAtYearEnd: -1, maxRollover: 2 }), []);
});

test('a negative cap is rejected', () => {
  assert.throws(() => rolloverEntries({ balanceAtYearEnd: 2, maxRollover: -1 }), /cannot be negative/);
});
