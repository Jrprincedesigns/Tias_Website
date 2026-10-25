import test from 'node:test';
import assert from 'node:assert/strict';
import { TIERS, MEMBER_DISCOUNT_METAFIELD, TIER_SUMMARY_METAFIELD } from '../app/lib/membership-tiers.ts';
import { productSetInput, type ExistingProduct } from '../app/lib/membership-provisioning.ts';

/**
 * "Check and repair setup" runs against a membership that may already be on
 * sale. These pin that a repair cannot take it off sale or undo Tia's edits.
 */

type VariantInput = {
  id?: string;
  metafields: Array<{ key: string; value: string }>;
};

const metafield = (variant: VariantInput, key: string) =>
  variant.metafields.find((m) => m.key === key)?.value;

test('a new membership is created as a draft, with our copy', () => {
  const input = productSetInput(null);
  assert.equal(input.status, 'DRAFT');
  assert.ok(input.descriptionHtml);

  const variants = input.variants as VariantInput[];
  assert.equal(variants.length, TIERS.length);
  TIERS.forEach((tier, i) => {
    const variant = variants[i]!;
    assert.equal(variant.id, undefined);
    assert.equal(metafield(variant, MEMBER_DISCOUNT_METAFIELD.key), String(tier.discountPercent));
    assert.equal(metafield(variant, TIER_SUMMARY_METAFIELD.key), tier.summary);
  });
});

test('a repair leaves status and description alone', () => {
  const existing: ExistingProduct = {
    id: 'gid://shopify/Product/1',
    variants: TIERS.map((tier, i) => ({
      id: `gid://shopify/ProductVariant/${i}`,
      title: tier.name,
      discount: null,
      summary: null,
    })),
  };
  const input = productSetInput(existing);
  // Omitted scalars are left as they are, so a published product stays published.
  assert.equal('status' in input, false);
  assert.equal('descriptionHtml' in input, false);
});

test('a repair keeps variant ids and the copy edited in admin', () => {
  const existing: ExistingProduct = {
    id: 'gid://shopify/Product/1',
    variants: [
      { id: 'gid://shopify/ProductVariant/10', title: 'Essential Care', discount: { value: '12' }, summary: { value: 'Edited by Tia' } },
      { id: 'gid://shopify/ProductVariant/11', title: 'Signature Care', discount: null, summary: { value: '  ' } },
      // Collection Care missing: a variant the store does not have yet is created.
    ],
  };
  const [essential, signature, collection] = (productSetInput(existing).variants as VariantInput[]) as [
    VariantInput,
    VariantInput,
    VariantInput,
  ];

  assert.equal(essential.id, 'gid://shopify/ProductVariant/10');
  assert.equal(metafield(essential, MEMBER_DISCOUNT_METAFIELD.key), '12');
  assert.equal(metafield(essential, TIER_SUMMARY_METAFIELD.key), 'Edited by Tia');

  // Blank in the store falls back to ours rather than sending an empty value.
  assert.equal(signature.id, 'gid://shopify/ProductVariant/11');
  assert.equal(metafield(signature, MEMBER_DISCOUNT_METAFIELD.key), String(TIERS[1]!.discountPercent));
  assert.equal(metafield(signature, TIER_SUMMARY_METAFIELD.key), TIERS[1]!.summary);

  assert.equal(collection.id, undefined);
});
