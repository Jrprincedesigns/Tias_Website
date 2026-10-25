/**
 * The Wig Spa Membership — what gets sold, and on what terms.
 *
 * Every tier takes 10% off additional Wig Spa services — extra Rejuvenations
 * are full price — and includes Rejuvenations granted per three-month period
 * (allowance.ts has the rules).
 * A Rejuvenation is 2.5 hours of Tia's time, so the allowance is a fixed count
 * rather than open-ended, and the fee is what pays for those hours.
 *
 * Shape in Shopify: one product, three variants (the tiers), and one selling
 * plan group PER TIER, attached to that tier's variant. Each plan charges a
 * fixed price. Tiers used to share one group whose plans discounted from the
 * variant price, which only worked while every tier priced its terms in the
 * same ratio — Essential's monthly and annual prices do not fit that ratio, and
 * nothing says the other tiers' will either.
 *
 *                Monthly (3-month min)        Annual
 *   Essential     $18, 1 per 3 months          $195, 1 per 3 months (4 a year)
 *   Signature     $36, 2 per 3 months          $390, 2 per 3 months (8 a year)
 *   Collection    $70, 4 per 3 months          $760, 4 per 3 months (16 a year)
 *
 * Longer commitments cost less per month, which is the point.
 *
 * ─── What Tia can change without a developer ───────────────────────────────
 *
 * The member discount lives in a metafield on each variant, editable in admin.
 *
 * Prices and terms are the selling plans themselves, and Shopify fixes a
 * contract's terms at the moment it is created. Changing them means new plans
 * for new members while existing members keep what they bought — so they live
 * here, not on the variant.
 */

/** Metafield holding the member discount, so it is editable beside the price. */
export const MEMBER_DISCOUNT_METAFIELD = {
  namespace: 'wig_spa',
  key: 'member_discount_percent',
} as const;

/**
 * The line of copy under a tier's name, on the variant so Tia can rewrite it
 * without a deploy. Each tier says something different about who it is for and
 * what it actually changes — three cards repeating one sentence with a
 * different number in it reads like a price list rather than a choice.
 */
export const TIER_SUMMARY_METAFIELD = {
  namespace: 'wig_spa',
  key: 'tier_summary',
} as const;

export interface MembershipTerm {
  id: 'monthly' | 'annual';
  /** The plan name a member sees at checkout and on their cart line. */
  name: string;
  /** Billing interval, in months. */
  months: number;
  /** What one billing cycle costs. */
  price: number;
  /**
   * Cycles a member must pay before they can cancel. A prepaid term needs
   * only one — the whole term is charged up front — but a monthly plan would
   * let a member take the discount for a month and leave, so it carries a
   * minimum commitment instead.
   */
  minCycles: number;
  /** Rejuvenations granted each three-month period on this term. */
  rejuvenationsPerPeriod: number;
  /** Extra line for checkout, e.g. what an annual plan includes. */
  note?: string;
}

export interface MembershipTier {
  /** Stable key. Never shown to a member; used to match a contract to a tier. */
  id: 'essential' | 'signature' | 'collection';
  name: string;
  /** Percent off additional services, beyond what the tier includes. */
  discountPercent: number;
  summary: string;
  /**
   * Place in Tia's work queue, lowest first. Within each stage of the queue a
   * member's work sorts ahead of everyone without one; tiers without a number
   * wait in line like any other job.
   */
  queuePriority?: number;
  /** Shortest first. The storefront preselects the last, the best value. */
  terms: readonly MembershipTerm[];
}

export const TIERS: readonly MembershipTier[] = [
  {
    id: 'essential',
    name: 'Essential Care',
    discountPercent: 10,
    summary:
      'For one or two units you wear regularly. Includes 1 wig rejuvenation every 3 months, plus 10% off additional Wig Spa services (extra rejuvenations are full price).',
    terms: [
      {
        id: 'monthly', name: 'Monthly (3-month minimum)', months: 1, price: 18, minCycles: 3,
        rejuvenationsPerPeriod: 1,
      },
      {
        id: 'annual', name: 'Annual', months: 12, price: 195, minCycles: 1,
        rejuvenationsPerPeriod: 1,
        note: '4 rejuvenations, a $240 value',
      },
    ],
  },
  {
    id: 'signature',
    name: 'Signature Care',
    discountPercent: 10,
    queuePriority: 1,
    summary:
      'For a rotation you move between. Includes 2 wig rejuvenations every 3 months, 10% off additional Wig Spa services (extra rejuvenations are full price), and your work is booked ahead of standard jobs.',
    terms: [
      {
        id: 'monthly', name: 'Monthly (3-month minimum)', months: 1, price: 36, minCycles: 3,
        rejuvenationsPerPeriod: 2,
      },
      {
        id: 'annual', name: 'Annual', months: 12, price: 390, minCycles: 1,
        rejuvenationsPerPeriod: 2,
        note: '8 rejuvenations, a $480 value',
      },
    ],
  },
  {
    id: 'collection',
    name: 'Collection Care',
    discountPercent: 10,
    queuePriority: 0,
    summary:
      'For a wardrobe worth protecting. Includes 4 wig rejuvenations every 3 months, 10% off additional Wig Spa services (extra rejuvenations are full price), and your units go to the front of the queue.',
    terms: [
      {
        id: 'monthly', name: 'Monthly (3-month minimum)', months: 1, price: 70, minCycles: 3,
        rejuvenationsPerPeriod: 4,
      },
      {
        id: 'annual', name: 'Annual', months: 12, price: 760, minCycles: 1,
        rejuvenationsPerPeriod: 4,
        note: '16 rejuvenations, a $960 value',
      },
    ],
  },
];

/**
 * The price on the variant itself. Every plan sets its own price, so this is
 * never what a member pays — but it is what a product listing shows before a
 * term is chosen, so it is the full annual price rather than a low monthly
 * figure that reads as the cost of membership.
 */
export function variantPrice(tier: MembershipTier): number {
  return Math.max(...tier.terms.map((term) => term.price));
}

/** Monthly equivalent, for showing that a longer commitment costs less. */
export function monthlyEquivalent(term: MembershipTerm): number {
  return Math.round((term.price / term.months) * 100) / 100;
}

/**
 * Where a job sits in its stage of the queue: Collection, then Signature, then
 * everyone else. Takes the tier as the membership stores it (its name), and
 * null for a job with no active membership.
 */
export function queueRank(tier: string | null | undefined): number {
  return (tier ? tierFromNames(tier)?.queuePriority : undefined) ?? Number.MAX_SAFE_INTEGER;
}

export function tierById(id: string): MembershipTier | undefined {
  return TIERS.find((tier) => tier.id === id);
}

/**
 * Match a selling plan name back to its tier.
 *
 * The subscription webhook knows what a member bought only by the names on the
 * contract, so this is the join between Shopify's copy and our records. Falls
 * back to undefined rather than guessing — a membership attached to the wrong
 * tier would hand out the wrong discount indefinitely.
 */
export function tierFromNames(...names: (string | null | undefined)[]): MembershipTier | undefined {
  const haystack = names.filter(Boolean).join(' ').toLowerCase();
  return TIERS.find((tier) => haystack.includes(tier.name.toLowerCase()) || haystack.includes(tier.id));
}

/**
 * Match a contract's selling plan name back to the term within its tier.
 * Legacy plans ("Every 12 months") match nothing, which is correct: they were
 * sold without included Rejuvenations.
 */
export function termFromPlanName(
  tier: MembershipTier,
  planName: string | null | undefined,
): MembershipTerm | undefined {
  const name = planName?.trim().toLowerCase();
  if (!name) return undefined;
  // Exact first; then by its id word, so a plan renamed in admin from
  // "Annual" to "Annual membership" still finds its allowance.
  return (
    tier.terms.find((term) => term.name.toLowerCase() === name) ??
    tier.terms.find((term) => name.includes(term.id))
  );
}
