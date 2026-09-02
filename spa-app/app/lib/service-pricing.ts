/**
 * What a service should sell for.
 *
 * The model is one sentence: Tia takes a fixed share of every sale, and the
 * price is whatever makes that share pay for the hours the work actually
 * takes. Her pay is a percentage rather than an hourly cost line, so the
 * question "what am I earning on this?" has an answer that does not depend on
 * anyone reconstructing a spreadsheet.
 *
 *     price = (hours × target hourly) ÷ draw share
 *
 * The target hourly is not what she is paid — her draw is. It is the number
 * that decides where the price lands, and raising it lifts every service at
 * once, which is the entire reason it lives in one row.
 *
 * A price is never stored. It is derived on every read, because a stored price
 * is wrong the moment postage changes and nobody remembers to recompute it.
 */

export interface PricingSettings {
  ownerDrawPercent: number;
  targetHourlyCents: number;
  processingPercent: number;
  processingFixedCents: number;
  shippingCents: number;
}

export interface ServiceInput {
  id: string;
  name: string;
  hours: number;
  materialsCents: number;
  includesShipping: boolean;
  notes: string | null;
}

export interface PricedService extends ServiceInput {
  priceCents: number;
  /** Tia's cut of this sale. */
  drawCents: number;
  /** What she is effectively earning per hour at this price. */
  effectiveHourlyCents: number;
  /** Everything that has to be paid out before anyone is better off. */
  costCents: number;
  processingCents: number;
  shippingCents: number;
  /** What the business keeps. Negative means this service loses money. */
  retainedCents: number;
  /** True when the price does not even cover its costs and her draw. */
  underwater: boolean;
}

const round = (cents: number) => Math.round(cents);

/**
 * Price one service.
 *
 * Rounded up to the whole dollar. A service priced at $187.50 invites someone
 * to wonder whether it should be $187 or $188 every time they look at it, and
 * the half-dollar is never the thing that matters.
 */
export function priceService(service: ServiceInput, settings: PricingSettings): PricedService {
  const drawShare = settings.ownerDrawPercent / 100;

  const targetDrawCents = service.hours * settings.targetHourlyCents;
  const rawPrice = targetDrawCents / drawShare;
  const priceCents = Math.ceil(rawPrice / 100) * 100;

  const drawCents = round(priceCents * drawShare);
  const processingCents = round(
    priceCents * (settings.processingPercent / 100) + settings.processingFixedCents,
  );
  const shippingCents = service.includesShipping ? settings.shippingCents : 0;
  const costCents = service.materialsCents + shippingCents + processingCents;
  const retainedCents = priceCents - drawCents - costCents;

  return {
    ...service,
    priceCents,
    drawCents,
    effectiveHourlyCents: round(drawCents / service.hours),
    costCents,
    processingCents,
    shippingCents,
    retainedCents,
    underwater: retainedCents < 0,
  };
}

export function priceAll(
  services: readonly ServiceInput[],
  settings: PricingSettings,
): PricedService[] {
  return services.map((service) => priceService(service, settings));
}

/**
 * What an existing price is really paying, run backwards.
 *
 * This is the view that made the case for repricing in the first place: a
 * Rejuvenation at $60 pays $4.80 an hour and does not cover its own postage,
 * and none of that is visible from the price tag.
 */
export function auditPrice(
  service: ServiceInput,
  settings: PricingSettings,
  currentPriceCents: number,
): { drawCents: number; effectiveHourlyCents: number; retainedCents: number; underwater: boolean } {
  const drawCents = round(currentPriceCents * (settings.ownerDrawPercent / 100));
  const processingCents = round(
    currentPriceCents * (settings.processingPercent / 100) + settings.processingFixedCents,
  );
  const shippingCents = service.includesShipping ? settings.shippingCents : 0;
  const retainedCents =
    currentPriceCents - drawCents - service.materialsCents - shippingCents - processingCents;

  return {
    drawCents,
    effectiveHourlyCents: round(drawCents / service.hours),
    retainedCents,
    underwater: retainedCents < 0,
  };
}

export const money = (cents: number): string =>
  `${cents < 0 ? '-' : ''}$${Math.abs(cents / 100).toFixed(2)}`;
