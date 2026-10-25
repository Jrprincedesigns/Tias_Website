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
  id?: string;
  kind: AllowanceKind;
  delta: number;
  serviceRequestId?: string | null;
  reason?: string | null;
  createdAt?: Date;
  /** Grants only: the first day of the three-month period they belong to. */
  periodStart?: Date | null;
  /** Grants only: when whatever is left of this grant stops being usable. */
  expiresAt?: Date | null;
  /** Expiries only: the grant this expiry closes out. */
  expiresEntryId?: string | null;
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

// ─── Quarterly Rejuvenations ───────────────────────────────────────────────
//
// Included Rejuvenations are granted per three-month period, counted from the
// day the membership started. Unused ones roll into the next period, but each
// period's grant expires 30 days after that period ends — so a member has the
// quarter itself plus a 30-day grace to use it, and no longer.

export const PERIOD_MONTHS = 3;
export const GRACE_DAYS = 30;

/** Calendar months, clamped so Jan 31 + 1 month is Feb 28, not Mar 3. */
export function addMonths(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(date.getUTCDate(), lastDay)));
}

export function periodExpiry(periodStart: Date): Date {
  const end = addMonths(periodStart, PERIOD_MONTHS);
  return new Date(end.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Grants owed but not yet written.
 *
 * Written lazily — whenever a balance is read — rather than by a scheduler, so
 * an annual member, who is billed once a year, still receives each quarter's
 * Rejuvenations. Only periods that have started and are still inside their
 * grace window are granted: a period whose grant would already have expired
 * is skipped rather than granted and immediately taken back.
 *
 * Nothing is granted to a membership that is not active. Past due, paused and
 * cancelled members stop accruing at the moment they stop paying.
 */
export function dueGrants(input: {
  membershipStart: Date;
  status: MembershipWindow['status'];
  perPeriod: number | null;
  existingPeriodStarts: readonly Date[];
  now: Date;
}): LedgerEntry[] {
  const { membershipStart, status, perPeriod, now } = input;
  if (status !== 'active' || !perPeriod || perPeriod <= 0) return [];

  const existing = new Set(input.existingPeriodStarts.map((d) => d.getTime()));
  const grants: LedgerEntry[] = [];

  for (let n = 0; ; n++) {
    const periodStart = addMonths(membershipStart, n * PERIOD_MONTHS);
    if (periodStart > now) break;
    const expiresAt = periodExpiry(periodStart);
    if (expiresAt <= now || existing.has(periodStart.getTime())) continue;
    const entry: LedgerEntry = {
      kind: 'grant',
      delta: perPeriod,
      periodStart,
      expiresAt,
      reason: `${perPeriod} Rejuvenation${perPeriod === 1 ? '' : 's'} for the period starting ${periodStart.toISOString().slice(0, 10)}`,
    };
    assertDeltaDirection(entry.kind, entry.delta);
    grants.push(entry);
  }
  return grants;
}

interface Lot {
  id: string | undefined;
  expiresAt: Date | null;
  remaining: number;
}

/**
 * What is left of each grant, replaying the ledger in order.
 *
 * Every use is drawn from the grant that expires soonest and was still usable
 * when the use happened, so a member never loses a Rejuvenation to expiry
 * while holding an older one they could have spent instead.
 */
function replayLots(entries: readonly LedgerEntry[]): Lot[] {
  const lots: Lot[] = [];
  const ordered = [...entries].sort(
    (a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
  );

  for (const entry of ordered) {
    if (entry.delta > 0) {
      lots.push({ id: entry.id, expiresAt: entry.expiresAt ?? null, remaining: entry.delta });
      continue;
    }

    if (entry.kind === 'expiry' && entry.expiresEntryId) {
      const lot = lots.find((l) => l.id === entry.expiresEntryId);
      if (lot) lot.remaining += entry.delta;
      continue;
    }

    const at = entry.createdAt ?? new Date(0);
    let owed = -entry.delta;
    const usable = lots
      .filter((l) => l.remaining > 0 && (l.expiresAt === null || l.expiresAt > at))
      .sort((a, b) => (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity));
    for (const lot of usable) {
      if (owed === 0) break;
      const take = Math.min(lot.remaining, owed);
      lot.remaining -= take;
      owed -= take;
    }
  }
  return lots;
}

/** Expiry entries owed for grants whose grace window has closed. */
export function dueExpiries(entries: readonly LedgerEntry[], now: Date): LedgerEntry[] {
  const closed = new Set(
    entries.filter((e) => e.kind === 'expiry' && e.expiresEntryId).map((e) => e.expiresEntryId),
  );

  return replayLots(entries)
    .filter((lot) => lot.id && lot.expiresAt && lot.expiresAt <= now && lot.remaining > 0 && !closed.has(lot.id))
    .map((lot) => {
      const entry: LedgerEntry = {
        kind: 'expiry',
        delta: -lot.remaining,
        expiresEntryId: lot.id!,
        reason: `${lot.remaining} unused, expired ${lot.expiresAt!.toISOString().slice(0, 10)}`,
      };
      assertDeltaDirection(entry.kind, entry.delta);
      return entry;
    });
}

/**
 * Balance as of `now`, counting expiries that are due but not yet written.
 * Equal to balanceOf once the ledger has been settled.
 */
export function availableBalance(entries: readonly LedgerEntry[], now: Date = new Date()): number {
  return balanceOf(entries) + balanceOf(dueExpiries(entries, now));
}

/** The only service the allowance pays for. */
export const INCLUDED_SERVICE = 'rejuvenation';

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
  | {
      covered: false;
      reason: 'no_membership' | 'membership_inactive' | 'not_included' | 'no_services_left' | 'already_consumed';
    };

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
  /** When given, anything but a Rejuvenation is not covered. */
  serviceType?: string;
  now?: Date;
}): CoverageDecision {
  const { membership, entries, serviceRequestId } = input;

  if (!membership) return { covered: false, reason: 'no_membership' };

  // The allowance is Rejuvenations. Repairs, colour and the rest are charged,
  // at the member discount.
  if (input.serviceType !== undefined && input.serviceType !== INCLUDED_SERVICE) {
    return { covered: false, reason: 'not_included' };
  }

  // Past due deliberately blocks new coverage: a membership that isn't being
  // paid for shouldn't keep handing out services. Work already authorised is
  // governed by the status machine, not by this.
  if (membership.status !== 'active') return { covered: false, reason: 'membership_inactive' };

  const alreadyConsumed = entries.some(
    (entry) => entry.kind === 'consumption' && entry.serviceRequestId === serviceRequestId,
  );
  if (alreadyConsumed) return { covered: false, reason: 'already_consumed' };

  if (availableBalance(entries, input.now) < 1) return { covered: false, reason: 'no_services_left' };

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
  now?: Date;
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
 *
 * Superseded for included Rejuvenations, which expire per grant (see
 * dueExpiries) rather than at the end of a membership year.
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
