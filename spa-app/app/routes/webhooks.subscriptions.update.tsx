import type { ActionFunctionArgs } from 'react-router';
import { authenticate } from '../shopify.server';
import pool from '../db.server';
import { upsertMembershipFromContract } from '../lib/db';

/**
 * subscription_contracts/create and /update.
 *
 * This is the only thing that keeps membership state honest. Without it a
 * cancelled or lapsed membership keeps consuming allowance and honouring
 * member pricing, because nothing else in the system ever hears that the money
 * stopped — the storefront cannot be trusted to say so and Tia should not have
 * to notice by hand.
 *
 * The payload carries the contract id and its status but not the customer or
 * the plan, so those are read back from the Admin API. That extra call is the
 * point: it means the membership is written from what Shopify says now, not
 * from whatever a possibly-reordered delivery happened to contain.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);

  const contractId =
    (payload as any)?.admin_graphql_api_id ??
    ((payload as any)?.id ? `gid://shopify/SubscriptionContract/${(payload as any).id}` : null);

  if (!contractId) {
    console.warn(`[${topic}] ${shop}: no contract id in payload, nothing to do`);
    return new Response();
  }

  // `admin` is absent when the app has been uninstalled between the event and
  // its delivery. Acknowledge rather than fail: retrying cannot help.
  if (!admin) {
    console.warn(`[${topic}] ${shop}: no admin client (app uninstalled?), skipping ${contractId}`);
    return new Response();
  }

  const response = await admin.graphql(
    `#graphql
      query SubscriptionContractForWebhook($id: ID!) {
        subscriptionContract(id: $id) {
          id
          status
          nextBillingDate
          customer { id }
          lines(first: 1) {
            nodes {
              title
              sellingPlanName
            }
          }
        }
      }`,
    { variables: { id: contractId } },
  );

  const body = await response.json();
  const contract = body?.data?.subscriptionContract;

  if (!contract?.customer?.id) {
    console.warn(`[${topic}] ${shop}: contract ${contractId} has no customer, skipping`);
    return new Response();
  }

  const line = contract.lines?.nodes?.[0];
  // The selling plan name is the tier as the member bought it. Falling back to
  // the line title keeps a membership attached to something readable rather
  // than an empty string if the plan is ever renamed away.
  const tier = line?.sellingPlanName ?? line?.title ?? 'Membership';

  const { membershipId, created } = await upsertMembershipFromContract(pool, {
    shopifyContractId: contract.id,
    shopifyCustomerId: contract.customer.id,
    status: contract.status,
    tier,
    nextBillingAt: contract.nextBillingDate ? new Date(contract.nextBillingDate) : null,
  });

  console.log(
    `[${topic}] ${shop}: ${created ? 'created' : 'updated'} membership ${membershipId} ` +
      `(${contract.status}) from ${contract.id}`,
  );

  return new Response();
};
