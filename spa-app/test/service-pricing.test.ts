import test from 'node:test';
import assert from 'node:assert/strict';
import { auditPrice, priceService, type PricingSettings, type ServiceInput } from '../app/lib/service-pricing.ts';

const SETTINGS: PricingSettings = {
  ownerDrawPercent: 20,
  targetHourlyCents: 1500,
  processingPercent: 2.5,
  processingFixedCents: 30,
  shippingCents: 6800,
};

const rejuvenation: ServiceInput = {
  id: '1',
  name: 'Wig Rejuvenation',
  hours: 2.5,
  materialsCents: 800,
  includesShipping: true,
  notes: null,
};

test('the baseline prices come out of the model', () => {
  const cases: Array<[number, number, number]> = [
    // hours, materials, expected price in cents
    [2.5, 800, 18800],  // Rejuvenation
    [3.25, 800, 24400], // Reconstruction
    [4, 800, 30000],    // Construction
    [4.5, 2500, 33800], // Color
  ];
  for (const [hours, materialsCents, expected] of cases) {
    const priced = priceService({ ...rejuvenation, hours, materialsCents }, SETTINGS);
    assert.equal(priced.priceCents, expected, `${hours}h`);
  }
});

test('every baseline service covers its costs and her draw', () => {
  for (const hours of [2.5, 3.25, 4, 4.5]) {
    const priced = priceService({ ...rejuvenation, hours }, SETTINGS);
    assert.equal(priced.underwater, false, `${hours}h must not lose money`);
    assert.ok(priced.retainedCents > 0);
  }
});

test('her draw pays at least the target rate', () => {
  // The whole point of the model. If this fails the price is not doing its job.
  for (const hours of [2.5, 3.25, 4, 4.5]) {
    const priced = priceService({ ...rejuvenation, hours }, SETTINGS);
    assert.ok(
      priced.effectiveHourlyCents >= SETTINGS.targetHourlyCents,
      `${hours}h paid ${priced.effectiveHourlyCents} against a ${SETTINGS.targetHourlyCents} target`,
    );
  }
});

test('raising the target rate lifts every price', () => {
  const cheap = priceService(rejuvenation, SETTINGS);
  const dear = priceService(rejuvenation, { ...SETTINGS, targetHourlyCents: 2500 });
  assert.ok(dear.priceCents > cheap.priceCents);
});

test('dropping shipping does not change the price, only what is left', () => {
  // Price follows hours and her share. Shipping is a cost the price absorbs,
  // so removing it shows up as margin rather than as a cheaper service.
  const shipped = priceService(rejuvenation, SETTINGS);
  const dropOff = priceService({ ...rejuvenation, includesShipping: false }, SETTINGS);
  assert.equal(dropOff.priceCents, shipped.priceCents);
  assert.equal(dropOff.retainedCents - shipped.retainedCents, SETTINGS.shippingCents);
});

test("today's Rejuvenation price is underwater and pays $4.80 an hour", () => {
  // The finding that started all of this, pinned so it cannot be argued with.
  const audit = auditPrice(rejuvenation, SETTINGS, 6000);
  assert.equal(audit.effectiveHourlyCents, 480);
  assert.equal(audit.underwater, true);
});

test('Reconstruction at its current price already clears', () => {
  const recon: ServiceInput = { ...rejuvenation, name: 'Wig Reconstruction', hours: 3.25 };
  const audit = auditPrice(recon, SETTINGS, 25000);
  assert.equal(audit.underwater, false);
  assert.ok(audit.effectiveHourlyCents > 1500);
});
