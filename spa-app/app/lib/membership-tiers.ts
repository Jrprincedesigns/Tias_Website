/**
 * The Wig Spa Membership — what gets sold, and on what terms.
 *
 * Membership carries no included services. It is a discount, a place in the
 * queue, and nothing else. That is deliberate: a Rejuvenation is 2.5 hours of
 * Tia's time, and any plan that hands those out for a flat fee turns her
 * hourly rate into a function of how heavily members use it. Selling the
 * discount instead means the fee is margin and the labour is always paid for.
 *
 * Shape in Shopify: one product, three variants (the tiers), and one selling
 * plan group PER TIER, attached to that tier's variant. Each plan charges a
 * fixed price. Tiers used to share one group whose plans discounted from the
 * variant price, which only worked while every tier priced its terms in the
 * same ratio — Essential's monthly and annual prices do not fit that ratio, and
 * nothing says the other tiers' will either.
 *
 *   Essential   $18/mo (3-month minimum)   $195/yr
 *   Signature   $25/3mo   $45/6mo   $80/yr
 *   Collection  $45/3mo   $81/6mo   $144/yr
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
  id: 'monthly' | 'quarterly' | 'biannual' | 'annual';
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
}

export interface MembershipTier {
  /** Stable key. Never shown to a member; used to match a contract to a tier. */
  id: 'essential' | 'signature' | 'collection';
  name: string;
  /** Percent off other services. The whole value of the membership. */
  discountPercent: number;
  summary: string;
  /** Shortest first. The storefront preselects the last, the best value. */
  terms: readonly MembershipTerm[];
}

export const TIERS: readonly MembershipTier[] = [
  {
    id: 'essential',
    name: 'Essential Care',
    discountPercent: 10,
    summary: 'For one or two units you wear regularly. Ten percent off every service in the spa.',
    terms: [
      { id: 'monthly', name: 'Monthly (3-month minimum)', months: 1, price: 18, minCycles: 3 },
      { id: 'annual', name: 'Annual', months: 12, price: 195, minCycles: 1 },
    ],
  },
  {
    id: 'signature',
    name: 'Signature Care',
    discountPercent: 15,
    summary: 'For a rotation you move between. Fifteen percent off, and your work is booked ahead of standard jobs.',
    terms: [
      { id: 'quarterly', name: 'Every 3 months', months: 3, price: 25, minCycles: 1 },
      { id: 'biannual', name: 'Every 6 months', months: 6, price: 45, minCycles: 1 },
      { id: 'annual', name: 'Every 12 months', months: 12, price: 80, minCycles: 1 },
    ],
  },
  {
    id: 'collection',
    name: 'Collection Care',
    discountPercent: 20,
    summary: 'For a wardrobe worth protecting. Twenty percent off, and your units go to the front of the queue.',
    terms: [
      { id: 'quarterly', name: 'Every 3 months', months: 3, price: 45, minCycles: 1 },
      { id: 'biannual', name: 'Every 6 months', months: 6, price: 81, minCycles: 1 },
      { id: 'annual', name: 'Every 12 months', months: 12, price: 144, minCycles: 1 },
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
