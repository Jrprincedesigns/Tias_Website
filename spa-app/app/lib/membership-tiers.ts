/**
 * The Wig Spa Membership — what gets sold, and on what terms.
 *
 * Membership carries no included services. It is a discount, a place in the
 * queue, and nothing else. That is deliberate: a Rejuvenation is 2.5 hours of
 * Tia's time, and any plan that hands those out for a flat fee turns her
 * hourly rate into a function of how heavily members use it. Selling the
 * discount instead means the fee is margin and the labour is always paid for.
 *
 * Shape in Shopify: one product, three variants (the tiers), one selling plan
 * group with three plans (the terms). A tier's variant price is its TWELVE
 * MONTH price; the shorter terms reach their own price by discounting that per
 * cycle. That is what keeps a single selling plan group correct for all three
 * tiers — the ratios are identical, so one set of adjustments fits every row.
 *
 *   Essential   $48/yr    $27/6mo   $15/3mo
 *   Signature   $80/yr    $45/6mo   $25/3mo
 *   Collection  $144/yr   $81/6mo   $45/3mo
 *
 * Longer commitments cost less per month, which is the point: 3 months is the
 * full rate, 6 months saves ten percent, 12 months saves twenty.
 *
 * ─── What Tia can change without a developer ───────────────────────────────
 *
 * Prices live on the Shopify variants. She edits them in admin like any other
 * product and all three terms move with them, because the shorter terms are
 * expressed as a share of the annual price rather than as their own numbers.
 *
 * The member discount lives in a metafield on each variant, so it sits beside
 * the price in the same screen.
 *
 * What she cannot change here is the set of tiers or the term lengths — those
 * are the selling plans themselves, and Shopify fixes a contract's terms at
 * the moment it is created. Changing them means new plans for new members
 * while existing members keep what they bought.
 */

/** Metafield holding the member discount, so it is editable beside the price. */
export const MEMBER_DISCOUNT_METAFIELD = {
  namespace: 'wig_spa',
  key: 'member_discount_percent',
} as const;

export interface MembershipTier {
  /** Stable key. Never shown to a member; used to match a contract to a tier. */
  id: 'essential' | 'signature' | 'collection';
  name: string;
  /** The twelve-month price. Shorter terms are derived from it. */
  annualPrice: number;
  /** Percent off other services. The whole value of the membership. */
  discountPercent: number;
  summary: string;
}

export const TIERS: readonly MembershipTier[] = [
  {
    id: 'essential',
    name: 'Essential Care',
    annualPrice: 48,
    discountPercent: 10,
    summary: 'For one or two units that need routine upkeep.',
  },
  {
    id: 'signature',
    name: 'Signature Care',
    annualPrice: 80,
    discountPercent: 15,
    summary: 'For a rotation of units worn throughout the year.',
  },
  {
    id: 'collection',
    name: 'Collection Care',
    annualPrice: 144,
    discountPercent: 20,
    summary: 'For a full wardrobe of high-value units.',
  },
];

export interface MembershipTerm {
  id: 'quarterly' | 'biannual' | 'annual';
  name: string;
  /** Billing interval, in months. Also the prepaid window. */
  months: number;
  /**
   * What one cycle costs as a share of the annual price. Shopify expresses a
   * selling plan's price as an adjustment to the variant price, and it can
   * only adjust downward — which is why the variant holds the annual price
   * and every shorter term is a reduction from it rather than an increase.
   */
  shareOfAnnual: number;
}

export const TERMS: readonly MembershipTerm[] = [
  { id: 'quarterly', name: 'Every 3 months', months: 3, shareOfAnnual: 0.3125 },
  { id: 'biannual', name: 'Every 6 months', months: 6, shareOfAnnual: 0.5625 },
  { id: 'annual', name: 'Every 12 months', months: 12, shareOfAnnual: 1 },
];

/** What one cycle of this term costs for this tier. */
export function priceForTerm(tier: MembershipTier, term: MembershipTerm): number {
  return Math.round(tier.annualPrice * term.shareOfAnnual * 100) / 100;
}

/**
 * The percentage Shopify needs to reach that price from the variant price.
 *
 * Worth knowing before it surprises someone: the three-month plan is stored as
 * a ~69% discount, because it charges a quarter-year's share of an annual
 * price. It is not a 69% saving and should never be displayed as one — a theme
 * that renders "Save 69%" on a selling plan is reading this number out of
 * context.
 */
export function priceAdjustmentPercent(term: MembershipTerm): number {
  return Math.round((1 - term.shareOfAnnual) * 10000) / 100;
}

/** Monthly equivalent, for showing that a longer commitment costs less. */
export function monthlyEquivalent(tier: MembershipTier, term: MembershipTerm): number {
  return Math.round((priceForTerm(tier, term) / term.months) * 100) / 100;
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
