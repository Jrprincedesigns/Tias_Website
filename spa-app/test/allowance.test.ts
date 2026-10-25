import test from 'node:test';
import assert from 'node:assert/strict';
import {
  balanceOf,
  assertDeltaDirection,
  decideCoverage,
  consumptionEntry,
  rolloverEntries,
  addMonths,
  dueGrants,
  dueExpiries,
  availableBalance,
  holdEntries,
  type Hold,
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

// ─── Quarterly Rejuvenations ───────────────────────────────────────────────

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const start = d('2026-01-15');

test('months are calendar months, clamped at the end of a short month', () => {
  assert.deepEqual(addMonths(d('2026-01-31'), 1), d('2026-02-28'));
  assert.deepEqual(addMonths(d('2026-11-15'), 3), d('2027-02-15'));
});

test('a new member is granted the current period at once', () => {
  const grants = dueGrants({
    membershipStart: start, status: 'active', perPeriod: 2, existingPeriodStarts: [], now: d('2026-01-20'),
  });
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.delta, 2);
  assert.deepEqual(grants[0]!.periodStart, start);
  // Three months, then 30 days' grace.
  assert.deepEqual(grants[0]!.expiresAt, d('2026-05-15'));
});

test('each new period is granted, and one already granted is not', () => {
  const grants = dueGrants({
    membershipStart: start, status: 'active', perPeriod: 2, existingPeriodStarts: [start], now: d('2026-04-20'),
  });
  assert.deepEqual(grants.map((g) => g.periodStart), [d('2026-04-15')]);
});

test('a period past its grace window is not granted late', () => {
  const grants = dueGrants({
    membershipStart: start, status: 'active', perPeriod: 2, existingPeriodStarts: [], now: d('2026-06-01'),
  });
  assert.deepEqual(grants.map((g) => g.periodStart), [d('2026-04-15')]);
});

test('an annual year is four periods', () => {
  let existing: Date[] = [];
  let total = 0;
  for (const now of ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']) {
    const grants = dueGrants({ membershipStart: start, status: 'active', perPeriod: 4, existingPeriodStarts: existing, now: d(now) });
    existing = existing.concat(grants.map((g) => g.periodStart!));
    total += grants.reduce((n, g) => n + g.delta, 0);
  }
  assert.equal(total, 16);
});

test('nothing is granted to an inactive membership, or a term without Rejuvenations', () => {
  for (const status of ['past_due', 'paused', 'cancelled', 'expired'] as const) {
    assert.deepEqual(dueGrants({ membershipStart: start, status, perPeriod: 2, existingPeriodStarts: [], now: d('2026-02-01') }), []);
  }
  assert.deepEqual(dueGrants({ membershipStart: start, status: 'active', perPeriod: 0, existingPeriodStarts: [], now: d('2026-02-01') }), []);
  assert.deepEqual(dueGrants({ membershipStart: start, status: 'active', perPeriod: null, existingPeriodStarts: [], now: d('2026-02-01') }), []);
});

const january: LedgerEntry = {
  id: 'jan', kind: 'grant', delta: 2, createdAt: d('2026-01-15'), periodStart: d('2026-01-15'), expiresAt: d('2026-05-15'),
};
const april: LedgerEntry = {
  id: 'apr', kind: 'grant', delta: 2, createdAt: d('2026-04-15'), periodStart: d('2026-04-15'), expiresAt: d('2026-07-15'),
};
const used = (id: string, at: string): LedgerEntry => ({
  kind: 'consumption', delta: -1, serviceRequestId: id, createdAt: d(at),
});

test('unused Rejuvenations roll into the next period', () => {
  const entries = [january, april];
  assert.deepEqual(dueExpiries(entries, d('2026-05-01')), []);
  assert.equal(availableBalance(entries, d('2026-05-01')), 4);
});

test('a period\'s leftovers expire 30 days after it ends', () => {
  const entries = [january, april, used('a', '2026-02-01')];
  const expiries = dueExpiries(entries, d('2026-05-15'));
  assert.deepEqual(expiries.map((e) => [e.expiresEntryId, e.delta]), [['jan', -1]]);
  assert.equal(availableBalance(entries, d('2026-05-15')), 2);
});

test('a use draws on the grant that expires soonest', () => {
  // Used in April, with both grants open: it must come out of January's, or
  // the member loses one to expiry while still holding April's.
  const entries = [january, april, used('a', '2026-04-20'), used('b', '2026-04-21')];
  assert.deepEqual(dueExpiries(entries, d('2026-05-20')), []);
  assert.equal(availableBalance(entries, d('2026-05-20')), 2);
});

test('an expiry already written is not written again', () => {
  const written: LedgerEntry = { kind: 'expiry', delta: -2, expiresEntryId: 'jan', createdAt: d('2026-05-16') };
  const entries = [january, april, written];
  assert.deepEqual(dueExpiries(entries, d('2026-06-01')), []);
  assert.equal(availableBalance(entries, d('2026-06-01')), 2);
});

test('an expired Rejuvenation does not count toward coverage', () => {
  const decision = decideCoverage({
    membership: activeMembership, entries: [january], serviceRequestId: 'x', now: d('2026-05-16'),
  });
  assert.deepEqual(decision, { covered: false, reason: 'no_services_left' });
});

test('only a Rejuvenation is covered by the allowance', () => {
  assert.deepEqual(
    decideCoverage({ membership: activeMembership, entries: granted(2), serviceRequestId: 'x', serviceType: 'repair' }),
    { covered: false, reason: 'not_included' },
  );
  assert.deepEqual(
    decideCoverage({ membership: activeMembership, entries: granted(2), serviceRequestId: 'x', serviceType: 'rejuvenation' }),
    { covered: true },
  );
});

// ─── Holds: a booked Rejuvenation is reserved until approval ────────────────

const one: LedgerEntry = {
  id: 'one', kind: 'grant', delta: 1, createdAt: d('2026-01-15'), periodStart: d('2026-01-15'), expiresAt: d('2026-05-15'),
};
const hold = (id: string, at: string): Hold => ({ serviceRequestId: id, heldAt: d(at) });

test('a held Rejuvenation cannot be booked a second time', () => {
  const holds = [hold('first', '2026-02-01')];
  assert.equal(availableBalance([one, ...holdEntries(holds)], d('2026-02-02')), 0);
  assert.deepEqual(
    decideCoverage({ membership: activeMembership, entries: [one], holds, serviceRequestId: 'second', now: d('2026-02-02') }),
    { covered: false, reason: 'no_services_left' },
  );
});

test('a hold is not expired while the unit is in the post', () => {
  const holds = [hold('first', '2026-05-10')];
  assert.deepEqual(dueExpiries([one, ...holdEntries(holds)], d('2026-05-20')), []);
});

test('a hold booked in time is approved after its grant runs out', () => {
  const holds = [hold('first', '2026-05-10')];
  const decision = decideCoverage({
    membership: activeMembership, entries: [one], holds, serviceRequestId: 'first', now: d('2026-05-20'),
  });
  assert.deepEqual(decision, { covered: true });
  assert.equal(
    consumptionEntry({ membership: activeMembership, entries: [one], holds, serviceRequestId: 'first', now: d('2026-05-20') }).delta,
    -1,
  );
});

test('approval spends the same grant the hold reserved', () => {
  // Written at approval, dated to the booking: the ledger stays settled.
  const spent: LedgerEntry = { kind: 'consumption', delta: -1, serviceRequestId: 'first', createdAt: d('2026-05-10') };
  assert.deepEqual(dueExpiries([one, spent], d('2026-05-20')), []);
  assert.equal(availableBalance([one, spent], d('2026-05-20')), 0);
});

test('only the holds that fit are covered at approval, earliest booking first', () => {
  const holds = [hold('first', '2026-02-01'), hold('second', '2026-02-02')];
  const ask = (id: string) =>
    decideCoverage({ membership: activeMembership, entries: [one], holds, serviceRequestId: id, now: d('2026-02-03') });
  assert.deepEqual(ask('first'), { covered: true });
  assert.deepEqual(ask('second'), { covered: false, reason: 'no_services_left' });
});

test('a cancelled booking gives the Rejuvenation back while it is still in date', () => {
  // Cancelling leaves the hold list, and nothing else changes.
  assert.equal(availableBalance([one], d('2026-03-01')), 1);
});

test('a hold released after its grant expired does not bring it back', () => {
  // Two granted, one held; the other expired at the window. The hold is
  // cancelled after the window — the held one must not reappear.
  const two: LedgerEntry = { ...one, id: 'two', delta: 2 };
  const holds = [hold('first', '2026-05-01')];
  const expiries = dueExpiries([two, ...holdEntries(holds)], d('2026-05-20'));
  assert.deepEqual(expiries.map((e) => [e.expiresEntryId, e.delta]), [['two', -1]]);
  const written: LedgerEntry = { ...expiries[0]!, createdAt: d('2026-05-20') };

  assert.equal(availableBalance([two, written], d('2026-06-01')), 0);
  assert.deepEqual(dueExpiries([two, written], d('2026-06-01')), []);
});
