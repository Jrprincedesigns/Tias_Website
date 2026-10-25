import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TIERS,
  variantPrice,
  monthlyEquivalent,
  tierFromNames,
} from '../app/lib/membership-tiers.ts';

/**
 * These pin the pricing intent, which is the part that would be expensive to
 * get wrong: a contract is fixed at the moment it is created, so a mistake
 * here follows every member who signs up under it.
 */

test('the published prices come out of the model', () => {
  const expected: Record<string, Array<[number, number]>> = {
    // [months per cycle, price per cycle]
    essential: [[1, 18], [12, 195]],
    signature: [[1, 36], [12, 390]],
    collection: [[1, 70], [12, 760]],
  };
  for (const tier of TIERS) {
    const actual = tier.terms.map((term) => [term.months, term.price]);
    assert.deepEqual(actual, expected[tier.id], `${tier.name} prices`);
  }
});

test('every tier is monthly with a three-month minimum, or annual', () => {
  for (const tier of TIERS) {
    const monthly = tier.terms.find((t) => t.id === 'monthly')!;
    const annual = tier.terms.find((t) => t.id === 'annual')!;
    assert.equal(tier.terms.length, 2, tier.name);
    assert.equal(monthly.minCycles * monthly.months, 3, `${tier.name}: monthly commits to three months`);
    assert.equal(annual.minCycles, 1, `${tier.name}: annual is prepaid, so needs no further minimum`);
  }
});

test('included rejuvenations', () => {
  assert.deepEqual(
    TIERS.map((t) => t.rejuvenationsPerQuarter),
    [0, 2, 4],
  );
});

test('a longer commitment always costs less per month', () => {
  for (const tier of TIERS) {
    const monthly = tier.terms.map(monthlyEquivalent);
    for (let i = 1; i < monthly.length; i++) {
      assert.ok(
        monthly[i]! < monthly[i - 1]!,
        `${tier.name}: ${tier.terms[i]!.name} must beat ${tier.terms[i - 1]!.name} per month`,
      );
    }
  }
});

test('the variant price is the annual price, and no plan charges more', () => {
  // A listing shows the variant price before a term is chosen; showing the
  // monthly figure there would read as the whole cost of membership.
  for (const tier of TIERS) {
    const annual = tier.terms.find((t) => t.id === 'annual')!;
    assert.equal(variantPrice(tier), annual.price, tier.name);
  }
});

test('every tier ends on its annual term, so the storefront preselects it', () => {
  for (const tier of TIERS) {
    assert.equal(tier.terms.at(-1)!.id, 'annual', tier.name);
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

test('every tier takes ten percent off additional services', () => {
  assert.deepEqual(TIERS.map((t) => t.discountPercent), [10, 10, 10]);
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
