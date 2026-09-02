import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TIERS,
  TERMS,
  priceForTerm,
  priceAdjustmentPercent,
  monthlyEquivalent,
  tierFromNames,
} from '../app/lib/membership-tiers.ts';

/**
 * These pin the pricing intent, which is the part that would be expensive to
 * get wrong: a contract is fixed at the moment it is created, so a mistake
 * here follows every member who signs up under it.
 */

test('the published prices come out of the model', () => {
  const expected: Record<string, [number, number, number]> = {
    // 3 months, 6 months, 12 months
    essential: [15, 27, 48],
    signature: [25, 45, 80],
    collection: [45, 81, 144],
  };
  for (const tier of TIERS) {
    const actual = TERMS.map((term) => priceForTerm(tier, term));
    assert.deepEqual(actual, expected[tier.id], `${tier.name} prices`);
  }
});

test('a longer commitment always costs less per month', () => {
  for (const tier of TIERS) {
    const monthly = TERMS.map((term) => monthlyEquivalent(tier, term));
    for (let i = 1; i < monthly.length; i++) {
      assert.ok(
        monthly[i]! < monthly[i - 1]!,
        `${tier.name}: ${TERMS[i]!.name} must beat ${TERMS[i - 1]!.name} per month`,
      );
    }
  }
});

test('one set of plan adjustments fits every tier', () => {
  // This is what lets a single selling plan group serve all three tiers. If a
  // tier ever prices out of ratio, the group silently charges it wrongly.
  for (const term of TERMS) {
    const percents = TIERS.map(
      (tier) => Math.round((priceForTerm(tier, term) / tier.annualPrice) * 10000) / 100,
    );
    assert.equal(new Set(percents).size, 1, `${term.name} must be one ratio across tiers`);
  }
});

test('the annual plan is charged at the variant price', () => {
  const annual = TERMS.find((t) => t.id === 'annual')!;
  assert.equal(priceAdjustmentPercent(annual), 0);
  for (const tier of TIERS) {
    assert.equal(priceForTerm(tier, annual), tier.annualPrice);
  }
});

test('a contract can be matched back to its tier by name', () => {
  assert.equal(tierFromNames('Signature Care', 'Every 6 months')?.id, 'signature');
  assert.equal(tierFromNames('The Wig Spa Membership — Collection Care')?.id, 'collection');
  assert.equal(tierFromNames('essential')?.id, 'essential');
});

test('an unrecognised plan matches nothing rather than guessing', () => {
  // Guessing would attach a membership to the wrong tier and hand out the
  // wrong discount for as long as the contract lives.
  assert.equal(tierFromNames('Some Other Product'), undefined);
  assert.equal(tierFromNames(null, undefined), undefined);
});

test('discounts rise with the tier', () => {
  const percents = TIERS.map((t) => t.discountPercent);
  assert.deepEqual(percents, [...percents].sort((a, b) => a - b));
  assert.deepEqual(percents, [10, 15, 20]);
});

test('the tier is found on the variant title, not the plan or product name', () => {
  // The first real membership was filed as "Every 12 months" because only the
  // product title and the plan name were searched. A subscription line names
  // the product, the variant and the term separately, and only the variant
  // carries the tier.
  assert.equal(tierFromNames('The Wig Spa Membership'), undefined, 'product title alone says nothing');
  assert.equal(tierFromNames('Every 12 months'), undefined, 'a billing interval is not a tier');
  assert.equal(
    tierFromNames('Signature Care', 'Every 12 months', 'The Wig Spa Membership')?.id,
    'signature',
    'the variant title decides it',
  );
});
