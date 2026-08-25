import type { ServiceStatus } from './service-status.ts';
import type { ServiceRequestSummary } from './db.ts';

/**
 * Turning a list of work orders into a morning.
 *
 * The queue is grouped by what it asks of Tia rather than listed by status,
 * because "what do I do next" is the actual question. A raw table makes the
 * urgent and the merely-open look identical.
 *
 * Buckets are ordered by who is waiting: a customer waiting on an answer
 * outranks a wig waiting on a bench, and both outrank a parcel in transit
 * that nobody can hurry.
 */

export interface QueueBucket {
  key: string;
  /** Written as an instruction, not a status name. */
  title: string;
  statuses: readonly ServiceStatus[];
  /** True when nothing in here needs Tia — it is someone else's move. */
  waitingOnOthers: boolean;
  items: ServiceRequestSummary[];
  staleCount: number;
}

const BUCKETS: ReadonlyArray<Omit<QueueBucket, 'items' | 'staleCount'>> = [
  {
    key: 'approval',
    title: 'Waiting on customer approval',
    statuses: ['awaiting_customer_approval'],
    // Not Tia's move, but the one most likely to rot: a quote nobody chased
    // is a wig sitting in a bin while the customer forgets they were asked.
    waitingOnOthers: true,
  },
  { key: 'inspect', title: 'Arrived — needs inspection', statuses: ['received', 'inspection'], waitingOnOthers: false },
  { key: 'bench', title: 'On the bench', statuses: ['approved', 'in_service', 'quality_check'], waitingOnOthers: false },
  { key: 'ship', title: 'Ready to ship home', statuses: ['ready_to_ship', 'returned_unserviced'], waitingOnOthers: false },
  { key: 'transit', title: 'In transit', statuses: ['awaiting_shipment', 'in_transit_to_studio', 'return_shipment', 'delivered'], waitingOnOthers: true },
  { key: 'new', title: 'Requested, not yet sent', statuses: ['requested'], waitingOnOthers: true },
];

/** Days in one stage before a work order is flagged. */
export const DEFAULT_STALE_AFTER_DAYS = 7;

export function staleAfterDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env.WIG_SPA_STALE_AFTER_DAYS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_AFTER_DAYS;
}

export function daysSince(date: Date, now: Date): number {
  return (now.getTime() - date.getTime()) / 86_400_000;
}

/**
 * One threshold across every stage, by decision. It will over-flag stages that
 * are legitimately slow — a reconstruction genuinely takes longer than a wash —
 * so if it starts crying wolf, give BUCKETS their own limits rather than
 * raising this one and going blind everywhere.
 */
export function isStale(item: ServiceRequestSummary, now: Date, threshold: number): boolean {
  return daysSince(item.statusSince, now) >= threshold;
}

export function buildQueue(
  items: readonly ServiceRequestSummary[],
  now: Date,
  threshold: number,
): { buckets: QueueBucket[]; totalOpen: number; totalStale: number } {
  const buckets = BUCKETS.map((definition) => {
    const matching = items
      .filter((item) => definition.statuses.includes(item.status))
      // Longest-waiting first inside each bucket, so the top of every list is
      // the one that has been ignored longest.
      .sort((a, b) => a.statusSince.getTime() - b.statusSince.getTime());

    return {
      ...definition,
      items: matching,
      staleCount: matching.filter((item) => isStale(item, now, threshold)).length,
    };
  }).filter((bucket) => bucket.items.length > 0);

  return {
    buckets,
    totalOpen: items.length,
    totalStale: buckets.reduce((sum, bucket) => sum + bucket.staleCount, 0),
  };
}

/** "3 days" / "1 day" / "today" — for a person, not a log file. */
export function waitingFor(item: ServiceRequestSummary, now: Date): string {
  const days = Math.floor(daysSince(item.statusSince, now));
  if (days < 1) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}
