/**
 * Membership allowances.
 *
 * The ledger in Postgres is the record; this module is the rules that decide
 * what may be written to it. Balance is always derived by summing deltas —
 * nothing here caches a count, because a cached count is a number nobody can
 * explain three months later when a member disputes it.
 *
 * Mirrors the `allowance_entry_kind` enum and the `allowance_delta_direction`
 * check constraint in supabase/migrations/0001_wig_spa_core.sql. The database
 * enforces these too; doing it here as well means a bad write fails with a
 * sentence a human can read instead of a constraint violation.
 */

export const ALLOWANCE_KINDS = ['grant', 'consumption', 'rollover', 'expiry', 'adjustment'] as const;
export type AllowanceKind = (typeof ALLOWANCE_KINDS)[number];

export interface LedgerEntry {
  kind: AllowanceKind;
  delta: number;
  serviceRequestId?: string | null;
  reason?: string | null;
}

export interface MembershipWindow {
  status: 'active' | 'past_due' | 'paused' | 'cancelled' | 'expired';
  membershipYearStart: Date;
  membershipYearEnd: Date;
}

/** Sum of every delta. The only correct way to ask "how many are left". */
export function balanceOf(entries: readonly LedgerEntry[]): number {
  return entries.reduce((total, entry) => total + entry.delta, 0);
}

/**
 * Direction rules. A grant that subtracts, or a consumption that adds, means
 * a caller has its sign backwards — and a sign error in an allowance ledger
 * is the kind of bug that quietly gives away free reconstructions.
 */
export function assertDeltaDirection(kind: AllowanceKind, delta: number): void {
  if (!Number.isInteger(delta)) {
    throw new Error(`Allowance delta must be a whole number, got ${delta}`);
  }
  if ((kind === 'grant' || kind === 'rollover') && delta <= 0) {
    throw new Error(`A ${kind} must add services, got ${delta}`);
  }
  if ((kind === 'consumption' || kind === 'expiry') && delta >= 0) {
    throw new Error(`A ${kind} must subtract services, got ${delta}`);
  }
  if (kind === 'adjustment' && delta === 0) {
    throw new Error('An adjustment of zero changes nothing');
  }
}

export type CoverageDecision =
  | { covered: true }
  | { covered: false; reason: 'no_membership' | 'membership_inactive' | 'no_services_left' | 'already_consumed' };

/**
 * Whether a service request can be covered by the membership.
 *
 * Deliberately separate from the act of consuming: the storefront asks this
 * to render "included with your membership" before anything is committed, and
 * the staff app asks the same question again at approval time. One rule, two
 * callers, no drift between what a member was told and what they were charged.
 */
export function decideCoverage(input: {
  membership: MembershipWindow | null;
  entries: readonly LedgerEntry[];
  serviceRequestId: string;
}): CoverageDecision {
  const { membership, entries, serviceRequestId } = input;

  if (!membership) return { covered: false, reason: 'no_membership' };

  // Past due deliberately blocks new coverage: a membership that isn't being
  // paid for shouldn't keep handing out services. Work already authorised is
  // governed by the status machine, not by this.
  if (membership.status !== 'active') return { covered: false, reason: 'membership_inactive' };

  const alreadyConsumed = entries.some(
    (entry) => entry.kind === 'consumption' && entry.serviceRequestId === serviceRequestId,
  );
  if (alreadyConsumed) return { covered: false, reason: 'already_consumed' };

  if (balanceOf(entries) < 1) return { covered: false, reason: 'no_services_left' };

  return { covered: true };
}

/**
 * The entry to write when a service is authorised. Throws rather than
 * returning null on an uncovered request — silently writing nothing is how a
 * member ends up serviced for free without anyone noticing.
 */
export function consumptionEntry(input: {
  membership: MembershipWindow | null;
  entries: readonly LedgerEntry[];
  serviceRequestId: string;
}): LedgerEntry {
  const decision = decideCoverage(input);
  if (!decision.covered) {
    throw new Error(`Service ${input.serviceRequestId} is not covered: ${decision.reason}`);
  }
  const entry: LedgerEntry = {
    kind: 'consumption',
    delta: -1,
    serviceRequestId: input.serviceRequestId,
  };
  assertDeltaDirection(entry.kind, entry.delta);
  return entry;
}

/**
 * What carries into the next membership year.
 *
 * Capped rather than unlimited. Unlimited rollover accrues a service debt the
 * studio has to honour in some future month it can't forecast — §14 of the
 * brief, and the reason the cap is a parameter rather than a constant is that
 * the policy isn't settled yet.
 */
export function rolloverEntries(input: {
  balanceAtYearEnd: number;
  maxRollover: number;
}): LedgerEntry[] {
  const { balanceAtYearEnd, maxRollover } = input;

  if (maxRollover < 0) throw new Error('maxRollover cannot be negative');
  if (balanceAtYearEnd <= 0) return [];

  const carried = Math.min(balanceAtYearEnd, maxRollover);
  const forfeited = balanceAtYearEnd - carried;

  const entries: LedgerEntry[] = [];

  // Expire the whole closing balance, then re-grant what carries. Two entries
  // rather than one net figure so the member's history shows what they lost,
  // not just what they kept.
  entries.push({
    kind: 'expiry',
    delta: -balanceAtYearEnd,
    reason: `Membership year ended with ${balanceAtYearEnd} unused`,
  });

  if (carried > 0) {
    entries.push({
      kind: 'rollover',
      delta: carried,
      reason: forfeited > 0
        ? `${carried} carried forward, ${forfeited} forfeited over the ${maxRollover} cap`
        : `${carried} carried forward`,
    });
  }

  for (const entry of entries) assertDeltaDirection(entry.kind, entry.delta);
  return entries;
}
