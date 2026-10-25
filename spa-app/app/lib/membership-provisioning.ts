import {
  MEMBER_DISCOUNT_METAFIELD,
  TIER_SUMMARY_METAFIELD,
  TIERS,
  monthlyEquivalent,
  variantPrice,
  type MembershipTerm,
  type MembershipTier,
} from './membership-tiers.ts';

/**
 * Creating the membership in Shopify.
 *
 * Everything here is written to be run more than once. Selling plans are the
 * one thing in this system that cannot be corrected after the fact — a
 * contract is fixed at the moment a member buys it — so provisioning must
 * never be a script someone is afraid to re-run, and must never quietly create
 * a second group alongside the first.
 *
 * The product is matched by handle and each tier's group by its merchant code,
 * both of which are stable strings rather than ids we would otherwise have to
 * store.
 */

export const MEMBERSHIP_HANDLE = 'wig-spa-membership';

/** One selling plan group per tier, attached to that tier's variant. */
export function sellingPlanMerchantCode(tierId: string): string {
  return `wig-spa-membership-${tierId}`;
}

/**
 * The group every tier used to share. Still in the store, because members
 * bought on it — provisioning only takes it off the product.
 */
export const LEGACY_SELLING_PLAN_MERCHANT_CODE = 'wig-spa-membership-terms';

/** Anything the Admin API can be asked a GraphQL question. */
export interface AdminClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

export interface ProvisionResult {
  productId: string;
  productHandle: string;
  sellingPlanGroups: Array<{ tier: string; id: string; created: boolean }>;
  created: { product: boolean };
  /** Whether the old shared group was found and taken off the product. */
  detachedLegacyGroup: boolean;
  variants: Array<{ id: string; tier: string; price: number }>;
}

async function run<T>(
  admin: AdminClient,
  query: string,
  variables: Record<string, unknown>,
  pick: (data: any) => { result: T; userErrors: Array<{ field?: unknown; message: string }> },
  label: string,
): Promise<T> {
  const response = await admin.graphql(query, { variables });
  const body: any = await response.json();

  if (body.errors?.length) {
    throw new Error(`${label} failed: ${body.errors.map((e: any) => e.message).join('; ')}`);
  }

  const { result, userErrors } = pick(body.data);
  if (userErrors?.length) {
    // userErrors are the ones worth reading — they name the field Shopify
    // rejected, which is almost always the actual mistake.
    throw new Error(
      `${label} rejected: ${userErrors.map((e) => `${JSON.stringify(e.field)} ${e.message}`).join('; ')}`,
    );
  }
  return result;
}

/** The product and its tier variants. Matched by handle, so re-runnable. */
async function upsertProduct(admin: AdminClient): Promise<{
  id: string;
  handle: string;
  created: boolean;
  variants: Array<{ id: string; title: string; price: string }>;
}> {
  const existing = await run<any>(
    admin,
    `#graphql
      query MembershipProduct($handle: String!) {
        productByIdentifier(identifier: { handle: $handle }) {
          id
          handle
          variants(first: 20) { nodes { id title price } }
        }
      }`,
    { handle: MEMBERSHIP_HANDLE },
    (data) => ({ result: data.productByIdentifier, userErrors: [] }),
    'membership product lookup',
  );

  const variants = TIERS.map((tier) => ({
    optionValues: [{ optionName: 'Tier', name: tier.name }],
    // Never what a member pays — every plan sets its own price.
    price: variantPrice(tier).toFixed(2),
    inventoryPolicy: 'CONTINUE',
    // A membership is not a parcel. Left shippable, checkout asks a member for
    // a delivery address and quotes them postage on a discount card — which is
    // exactly what it did the first time this ran, because the flag lives on
    // the inventory item and not on the variant.
    inventoryItem: { requiresShipping: false, tracked: false },
    metafields: [
      {
        namespace: MEMBER_DISCOUNT_METAFIELD.namespace,
        key: MEMBER_DISCOUNT_METAFIELD.key,
        type: 'number_integer',
        value: String(tier.discountPercent),
      },
      {
        namespace: TIER_SUMMARY_METAFIELD.namespace,
        key: TIER_SUMMARY_METAFIELD.key,
        type: 'single_line_text_field',
        value: tier.summary,
      },
    ],
  }));

  const product = await run<any>(
    admin,
    `#graphql
      mutation MembershipProductSet($input: ProductSetInput!) {
        productSet(input: $input, synchronous: true) {
          product {
            id
            handle
            variants(first: 20) { nodes { id title price } }
          }
          userErrors { field message }
        }
      }`,
    {
      input: {
        handle: MEMBERSHIP_HANDLE,
        title: 'The Wig Spa Membership',
        descriptionHtml:
          '<p>Member pricing on every Wig Spa service, included Rejuvenations on Signature and Collection, ' +
          'and a place at the front of the studio queue. ' +
          'Choose the tier that matches how many units you wear, and the term that suits you — ' +
          'longer commitments cost less per month.</p>',
        productType: 'Membership',
        vendor: 'The T Collection',
        status: 'DRAFT',
        // Without this a membership can be bought outright, off a selling
        // plan — which is what happened the first time it was tested. The
        // order goes through at the variant's annual price, no subscription
        // contract is created, so no webhook fires, no membership is recorded
        // and no member tag is applied. The customer pays and gets nothing.
        requiresSellingPlan: true,
        productOptions: [
          { name: 'Tier', values: TIERS.map((tier) => ({ name: tier.name })) },
        ],
        variants,
      },
    },
    (data) => ({ result: data.productSet.product, userErrors: data.productSet.userErrors }),
    'membership product',
  );

  return {
    id: product.id,
    handle: product.handle,
    created: !existing,
    variants: product.variants.nodes,
  };
}

/** Turns a term into the selling plan Shopify stores. */
function sellingPlanInput(tier: MembershipTier, term: MembershipTerm) {
  const cadence = term.months === 1 ? 'every month' : `once every ${term.months} months`;
  const minimum = term.minCycles > 1 ? `, ${term.minCycles * term.months}-month minimum` : '';
  const note = term.note ? `. ${term.note}` : '';

  return {
    name: term.name,
    // Shown to the member at checkout, so it says the thing they care about.
    description: `Billed $${term.price.toFixed(2)} ${cadence}${minimum}${note}`,
    options: [term.name],
    category: 'SUBSCRIPTION',
    billingPolicy: {
      recurring: {
        interval: 'MONTH',
        intervalCount: term.months,
        minCycles: term.minCycles,
      },
    },
    deliveryPolicy: {
      recurring: { interval: 'MONTH', intervalCount: term.months, preAnchorBehavior: 'ASAP' },
    },
    // Omitted when the plan charges the variant price: an adjustment that
    // changes nothing is not the same thing as no adjustment.
    ...(term.price !== variantPrice(tier)
      ? {
          pricingPolicies: [
            {
              fixed: {
                adjustmentType: 'PRICE',
                adjustmentValue: { fixedValue: term.price },
              },
            },
          ],
        }
      : {}),
  };
}

async function findSellingPlanGroup(admin: AdminClient, merchantCode: string): Promise<string | null> {
  const groups = await run<any>(
    admin,
    `#graphql
      query MembershipPlans($query: String!) {
        sellingPlanGroups(first: 10, query: $query) {
          nodes { id merchantCode }
        }
      }`,
    { query: `merchant_code:${merchantCode}` },
    (data) => ({ result: data.sellingPlanGroups.nodes, userErrors: [] }),
    'selling plan group lookup',
  );

  const match = groups.find((g: any) => g.merchantCode === merchantCode);
  return match?.id ?? null;
}

/**
 * Create a tier's terms, or attach its existing group to the tier's variant.
 *
 * Existing plans are deliberately left alone. Editing a plan changes the terms
 * under members already on it, and Shopify does not ask twice — so a re-run
 * confirms the group is attached and stops there. Changing a term means a new
 * plan for new members, which is a decision, not a deploy.
 */
async function upsertTierSellingPlanGroup(
  admin: AdminClient,
  tier: MembershipTier,
  variantId: string,
): Promise<{ id: string; created: boolean }> {
  const merchantCode = sellingPlanMerchantCode(tier.id);
  const existingId = await findSellingPlanGroup(admin, merchantCode);

  if (existingId) {
    await run<any>(
      admin,
      `#graphql
        mutation AttachMembershipPlans($id: ID!, $productVariantIds: [ID!]!) {
          sellingPlanGroupAddProductVariants(id: $id, productVariantIds: $productVariantIds) {
            sellingPlanGroup { id }
            userErrors { field message }
          }
        }`,
      { id: existingId, productVariantIds: [variantId] },
      (data) => ({
        result: data.sellingPlanGroupAddProductVariants.sellingPlanGroup,
        userErrors: data.sellingPlanGroupAddProductVariants.userErrors,
      }),
      `attaching ${tier.name} plans`,
    );
    return { id: existingId, created: false };
  }

  const group = await run<any>(
    admin,
    `#graphql
      mutation CreateMembershipPlans(
        $input: SellingPlanGroupInput!
        $resources: SellingPlanGroupResourceInput
      ) {
        sellingPlanGroupCreate(input: $input, resources: $resources) {
          sellingPlanGroup { id }
          userErrors { field message }
        }
      }`,
    {
      input: {
        name: `Wig Spa Membership — ${tier.name}`,
        merchantCode,
        options: ['Term'],
        position: 1,
        sellingPlansToCreate: tier.terms.map((term) => sellingPlanInput(tier, term)),
      },
      // The variant, not the product: a group on the product would offer
      // this tier's prices on every tier.
      resources: { productVariantIds: [variantId] },
    },
    (data) => ({
      result: data.sellingPlanGroupCreate.sellingPlanGroup,
      userErrors: data.sellingPlanGroupCreate.userErrors,
    }),
    `${tier.name} selling plans`,
  );

  return { id: group.id, created: true };
}

/**
 * Take the old shared group off the product, so new members only see the
 * per-tier terms. Members already on its plans are unaffected — a contract
 * carries its own copy of the terms it was bought on.
 */
async function detachLegacySellingPlanGroup(admin: AdminClient, productId: string): Promise<boolean> {
  const legacyId = await findSellingPlanGroup(admin, LEGACY_SELLING_PLAN_MERCHANT_CODE);
  if (!legacyId) return false;

  await run<any>(
    admin,
    `#graphql
      mutation DetachLegacyMembershipPlans($id: ID!, $productIds: [ID!]!) {
        sellingPlanGroupRemoveProducts(id: $id, productIds: $productIds) {
          removedProductIds
          userErrors { field message }
        }
      }`,
    { id: legacyId, productIds: [productId] },
    (data) => ({
      result: data.sellingPlanGroupRemoveProducts.removedProductIds,
      userErrors: data.sellingPlanGroupRemoveProducts.userErrors,
    }),
    'detaching the old shared membership plans',
  );
  return true;
}

/**
 * Put the membership in the store, or confirm it is already there.
 *
 * The product is created as a DRAFT. Publishing it is a decision for whoever
 * has checked the prices read correctly on the storefront — this should not be
 * able to put something on sale by being run.
 */
export async function provisionMembership(admin: AdminClient): Promise<ProvisionResult> {
  const product = await upsertProduct(admin);

  const groups: ProvisionResult['sellingPlanGroups'] = [];
  for (const tier of TIERS) {
    const variant = product.variants.find((v) => v.title === tier.name);
    if (!variant) throw new Error(`The membership product has no "${tier.name}" variant`);
    const group = await upsertTierSellingPlanGroup(admin, tier, variant.id);
    groups.push({ tier: tier.id, ...group });
  }

  // Only after every tier has its own terms, so there is no moment where the
  // product is on sale with no plans at all.
  const detachedLegacyGroup = await detachLegacySellingPlanGroup(admin, product.id);

  return {
    productId: product.id,
    productHandle: product.handle,
    sellingPlanGroups: groups,
    created: { product: product.created },
    detachedLegacyGroup,
    variants: product.variants.map((variant) => {
      const tier = TIERS.find((t) => t.name === variant.title);
      return { id: variant.id, tier: tier?.id ?? variant.title, price: Number(variant.price) };
    }),
  };
}

/** What each tier costs on each term — for showing before anything is created. */
export function pricingPreview(): Array<{
  tier: string;
  discountPercent: number;
  rejuvenationsPerQuarter: number;
  terms: Array<{ term: string; price: number; months: number; perMonth: number; minCycles: number }>;
}> {
  return TIERS.map((tier: MembershipTier) => ({
    tier: tier.name,
    discountPercent: tier.discountPercent,
    rejuvenationsPerQuarter: tier.rejuvenationsPerQuarter,
    terms: tier.terms.map((term) => ({
      term: term.name,
      price: term.price,
      months: term.months,
      perMonth: monthlyEquivalent(term),
      minCycles: term.minCycles,
    })),
  }));
}

/** The tag every member carries, whatever their tier. */
export const MEMBER_TAG = 'wig-spa-member';

/** Per-tier tag, e.g. wig-spa-signature. What a discount's segment matches on. */
export function tierTag(tierId: string): string {
  return `wig-spa-${tierId}`;
}

/**
 * Make the customer's tags say what their membership currently is.
 *
 * Tags are how member pricing is actually applied: a Shopify automatic
 * discount targets a customer segment, and the segment is defined by these.
 * So this is not bookkeeping — a member whose tag is missing pays full price,
 * and a lapsed member whose tag lingers keeps a discount they stopped paying
 * for.
 *
 * Every tier tag is removed before the right one is added, so a member moving
 * between tiers cannot end up holding two.
 */
export async function syncMemberTags(
  admin: AdminClient,
  input: { customerId: string; tierId: string | null; active: boolean },
): Promise<void> {
  const allTierTags = TIERS.map((tier) => tierTag(tier.id));
  const wanted = input.active && input.tierId ? [MEMBER_TAG, tierTag(input.tierId)] : [];
  const unwanted = [MEMBER_TAG, ...allTierTags].filter((tag) => !wanted.includes(tag));

  if (unwanted.length > 0) {
    await run<any>(
      admin,
      `#graphql
        mutation RemoveMemberTags($id: ID!, $tags: [String!]!) {
          tagsRemove(id: $id, tags: $tags) {
            userErrors { field message }
          }
        }`,
      { id: input.customerId, tags: unwanted },
      (data) => ({ result: null, userErrors: data.tagsRemove.userErrors }),
      'removing member tags',
    );
  }

  if (wanted.length > 0) {
    await run<any>(
      admin,
      `#graphql
        mutation AddMemberTags($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            userErrors { field message }
          }
        }`,
      { id: input.customerId, tags: wanted },
      (data) => ({ result: null, userErrors: data.tagsAdd.userErrors }),
      'adding member tags',
    );
  }
}
