import type { ActionFunctionArgs } from 'react-router';
import { authenticate } from '../shopify.server';
import pool from '../db.server';
import { membershipStatusFromContract, upsertMembershipFromContract } from '../lib/db';
import { syncMemberTags } from '../lib/membership-provisioning';
import { tierFromNames } from '../lib/membership-tiers';

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
              variantTitle
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
  // Which tier they bought has to be read back off the contract, because that
  // is what decides the discount they get. An unrecognised plan is recorded
  // under its own name rather than guessed at — a membership filed against the
  // wrong tier would hand out the wrong discount for as long as it lives.
  // The tier is the VARIANT title — "Signature Care". A line's `title` is the
  // product, "The Wig Spa Membership", and `sellingPlanName` is the term,
  // "Every 12 months". Matching on those two alone found nothing and filed the
  // first real membership under its billing interval, with no member tag at
  // all, because an unmatched tier means no tag can be chosen.
  const matched = tierFromNames(line?.variantTitle, line?.sellingPlanName, line?.title);
  const tier = matched?.name ?? line?.variantTitle ?? line?.sellingPlanName ?? 'Membership';

  if (!matched) {
    console.warn(
      `[${topic}] ${shop}: contract ${contract.id} does not match a known tier ` +
        `(variant "${line?.variantTitle ?? '?'}", plan "${line?.sellingPlanName ?? '?'}") ` +
        `— recorded, but no member tag applied`,
    );
  }

  const { membershipId, created } = await upsertMembershipFromContract(pool, {
    shopifyContractId: contract.id,
    shopifyCustomerId: contract.customer.id,
    status: contract.status,
    tier,
    nextBillingAt: contract.nextBillingDate ? new Date(contract.nextBillingDate) : null,
  });

  // Tags are what actually apply member pricing, so they follow the contract's
  // status rather than its existence: a paused or cancelled membership loses
  // the discount at the same moment it stops being paid for.
  const status = membershipStatusFromContract(contract.status);
  await syncMemberTags(admin, {
    customerId: contract.customer.id,
    tierId: matched?.id ?? null,
    active: status === 'active',
  });

  console.log(
    `[${topic}] ${shop}: ${created ? 'created' : 'updated'} membership ${membershipId} ` +
      `(${status}) from ${contract.id}${matched ? ` as ${matched.name}` : ''}`,
  );

  return new Response();
};
