import {
  MEMBER_DISCOUNT_METAFIELD,
  TERMS,
  TIERS,
  priceAdjustmentPercent,
  priceForTerm,
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
 * The product is matched by handle and the group by its merchant code, both of
 * which are stable strings rather than ids we would otherwise have to store.
 */

export const MEMBERSHIP_HANDLE = 'wig-spa-membership';
export const SELLING_PLAN_MERCHANT_CODE = 'wig-spa-membership-terms';

/** Anything the Admin API can be asked a GraphQL question. */
export interface AdminClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

export interface ProvisionResult {
  productId: string;
  productHandle: string;
  sellingPlanGroupId: string;
  created: { product: boolean; sellingPlanGroup: boolean };
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

/** The product and its three tier variants. Matched by handle, so re-runnable. */
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
    // The variant carries the ANNUAL price; shorter terms discount from it.
    price: tier.annualPrice.toFixed(2),
    inventoryPolicy: 'CONTINUE',
    // A membership is not a parcel. Left shippable, Shopify would ask a member
    // for a delivery address and quote them postage on a discount card.
    requiresComponents: false,
    metafields: [
      {
        namespace: MEMBER_DISCOUNT_METAFIELD.namespace,
        key: MEMBER_DISCOUNT_METAFIELD.key,
        type: 'number_integer',
        value: String(tier.discountPercent),
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
          '<p>Member pricing on every Wig Spa service, and a place at the front of the studio queue. ' +
          'Choose the tier that matches how many units you wear, and the term that suits you — ' +
          'longer commitments cost less per month.</p>',
        productType: 'Membership',
        vendor: 'The T Collection',
        status: 'DRAFT',
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
function sellingPlanInput(term: (typeof TERMS)[number]) {
  const percentOff = priceAdjustmentPercent(term);

  return {
    name: term.name,
    // Shown to the member at checkout, so it says the thing they care about.
    description: `Billed once every ${term.months} months`,
    options: [term.name],
    category: 'SUBSCRIPTION',
    billingPolicy: {
      recurring: {
        interval: 'MONTH',
        intervalCount: term.months,
        // Prepaid: the whole term is charged at the start of the cycle, which
        // is what makes a member unable to take the discount and leave before
        // paying for it. No minimum cycle count is needed on top of that.
        minCycles: 1,
      },
    },
    deliveryPolicy: {
      recurring: { interval: 'MONTH', intervalCount: term.months, preAnchorBehavior: 'ASAP' },
    },
    // Omitted entirely for the annual term: it is charged at the variant price,
    // and an adjustment of zero is not the same thing as no adjustment.
    ...(percentOff > 0
      ? {
          pricingPolicies: [
            {
              fixed: {
                adjustmentType: 'PERCENTAGE',
                adjustmentValue: { percentage: percentOff },
              },
            },
          ],
        }
      : {}),
  };
}

async function findSellingPlanGroup(admin: AdminClient): Promise<string | null> {
  const groups = await run<any>(
    admin,
    `#graphql
      query MembershipPlans($query: String!) {
        sellingPlanGroups(first: 10, query: $query) {
          nodes { id merchantCode }
        }
      }`,
    { query: `merchant_code:${SELLING_PLAN_MERCHANT_CODE}` },
    (data) => ({ result: data.sellingPlanGroups.nodes, userErrors: [] }),
    'selling plan group lookup',
  );

  const match = groups.find((g: any) => g.merchantCode === SELLING_PLAN_MERCHANT_CODE);
  return match?.id ?? null;
}

/**
 * Create the three terms, or attach the existing group to the product.
 *
 * Existing plans are deliberately left alone. Editing a plan changes the terms
 * under members already on it, and Shopify does not ask twice — so a re-run
 * confirms the group is attached and stops there. Changing a term means a new
 * plan for new members, which is a decision, not a deploy.
 */
async function upsertSellingPlanGroup(
  admin: AdminClient,
  productId: string,
): Promise<{ id: string; created: boolean }> {
  const existingId = await findSellingPlanGroup(admin);

  if (existingId) {
    await run<any>(
      admin,
      `#graphql
        mutation AttachMembershipPlans($id: ID!, $productIds: [ID!]!) {
          sellingPlanGroupAddProducts(id: $id, productIds: $productIds) {
            sellingPlanGroup { id }
            userErrors { field message }
          }
        }`,
      { id: existingId, productIds: [productId] },
      (data) => ({
        result: data.sellingPlanGroupAddProducts.sellingPlanGroup,
        userErrors: data.sellingPlanGroupAddProducts.userErrors,
      }),
      'attaching membership plans',
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
        name: 'Wig Spa Membership',
        merchantCode: SELLING_PLAN_MERCHANT_CODE,
        options: ['Term'],
        position: 1,
        sellingPlansToCreate: TERMS.map(sellingPlanInput),
      },
      resources: { productIds: [productId] },
    },
    (data) => ({
      result: data.sellingPlanGroupCreate.sellingPlanGroup,
      userErrors: data.sellingPlanGroupCreate.userErrors,
    }),
    'membership selling plans',
  );

  return { id: group.id, created: true };
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
  const group = await upsertSellingPlanGroup(admin, product.id);

  return {
    productId: product.id,
    productHandle: product.handle,
    sellingPlanGroupId: group.id,
    created: { product: product.created, sellingPlanGroup: group.created },
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
  terms: Array<{ term: string; price: number; perMonth: number }>;
}> {
  return TIERS.map((tier: MembershipTier) => ({
    tier: tier.name,
    discountPercent: tier.discountPercent,
    terms: TERMS.map((term) => ({
      term: term.name,
      price: priceForTerm(tier, term),
      perMonth: Math.round((priceForTerm(tier, term) / term.months) * 100) / 100,
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
