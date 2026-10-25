import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from 'react-router';
import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import { boundary } from '@shopify/shopify-app-react-router/server';
import { useRouteError } from 'react-router';
import { authenticate } from '../shopify.server';
import { MEMBERSHIP_HANDLE, provisionMembership, pricingPreview } from '../lib/membership-provisioning.ts';

/**
 * Setting up the membership, and seeing what it currently costs.
 *
 * Deliberately a screen with a button rather than a script someone runs from a
 * laptop: selling plans are the one thing here that cannot be corrected later,
 * so the person who owns the prices should be the person who presses it, and
 * should be able to read the prices on the way past.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query MembershipStatus($handle: String!) {
        productByIdentifier(identifier: { handle: $handle }) {
          id
          title
          status
          onlineStoreUrl
          sellingPlanGroupCount
        }
      }`,
    { variables: { handle: MEMBERSHIP_HANDLE } },
  );
  const body: any = await response.json();
  const product = body?.data?.productByIdentifier ?? null;

  return {
    pricing: pricingPreview(),
    product: product
      ? {
          title: product.title,
          status: product.status,
          planGroups: product.sellingPlanGroupCount ?? 0,
          live: Boolean(product.onlineStoreUrl),
        }
      : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  try {
    const result = await provisionMembership(admin);
    return {
      ok: true as const,
      created: result.created,
      sellingPlanGroups: result.sellingPlanGroups,
      detachedLegacyGroup: result.detachedLegacyGroup,
      variants: result.variants,
    };
  } catch (error) {
    // The message from a userError names the field Shopify refused, which is
    // the only useful thing to put in front of someone here.
    return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
  }
};

export default function MembershipSetup() {
  const { pricing, product } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const running = navigation.state === 'submitting';

  return (
    <s-page heading="Membership">
      <s-section heading="What members pay">
        <s-paragraph>
          Every tier takes 10% off all additional Wig Spa services. Rejuvenations are credited every
          three months; unused ones roll over, and each period's expire 30 days after it ends.
        </s-paragraph>

        {pricing.map((tier) => (
          <s-section key={tier.tier} heading={`${tier.tier} — ${tier.discountPercent}% off additional services`}>
            {tier.terms.map((term) => (
              <s-paragraph key={term.term}>
                <s-text>{term.term}</s-text>: ${term.price.toFixed(2)}
                {term.months > 1 && ` ($${term.perMonth.toFixed(2)} per month)`}
                {' · '}
                {term.rejuvenationsPerPeriod
                  ? `${term.rejuvenationsPerPeriod} Rejuvenation${term.rejuvenationsPerPeriod === 1 ? '' : 's'} every 3 months`
                  : 'no Rejuvenations included'}
              </s-paragraph>
            ))}
          </s-section>
        ))}

        <s-paragraph>
          Each tier has its own selling plans, and each plan sets its own price. The discount lives
          on each variant's <s-text>member_discount_percent</s-text> metafield, so it can be changed
          in the product screen. Price and term changes apply to new members only — Shopify fixes a
          subscription's terms when it is bought.
        </s-paragraph>
      </s-section>

      <s-section heading="In this store">
        {product ? (
          <>
            <s-paragraph>
              <s-text>{product.title}</s-text> exists — status {product.status.toLowerCase()},{' '}
              {product.planGroups} selling plan group{product.planGroups === 1 ? '' : 's'} attached.
            </s-paragraph>
            {!product.live && (
              <s-banner tone="warning">
                The product is not published, so nobody can buy a membership yet. Publish it from the
                product screen once the prices read correctly on the storefront.
              </s-banner>
            )}
          </>
        ) : (
          <s-paragraph>No membership product yet. Setting it up creates one as a draft.</s-paragraph>
        )}

        {result?.ok === false && <s-banner tone="critical">{result.message}</s-banner>}

        {result?.ok && (
          <s-banner tone="success">
            {result.created.product ? 'Created the membership product' : 'Membership product already existed'}
            {'. '}
            {result.sellingPlanGroups
              .map((group) => `${group.tier}: ${group.created ? 'created its terms' : 'terms already set up, left untouched'}`)
              .join('; ')}
            {'. '}
            {result.detachedLegacyGroup && 'The old shared terms were taken off the product; existing members keep theirs.'}
          </s-banner>
        )}

        <Form method="post">
          <s-button type="submit" variant="primary" disabled={running}>
            {running ? 'Setting up…' : product ? 'Check and repair setup' : 'Set up membership'}
          </s-button>
        </Form>

        <s-paragraph>
          Safe to press more than once. Existing plans are never edited — changing a term would
          change it for members already on it, so a new term means a new plan.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
