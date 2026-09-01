import type { ActionFunctionArgs } from 'react-router';
import { authenticate } from '../shopify.server';
import pool from '../db.server';
import { reconcilePaidOrder } from '../lib/db';

/**
 * orders/paid.
 *
 * Closes the "approve additional work" loop. Inspection finds work beyond what
 * was booked, Tia raises a draft order, the member pays it — and this is what
 * tells the work order the money arrived, so it stops reading as still waiting
 * on payment.
 *
 * Most orders that arrive here are ordinary shop orders with nothing to do
 * with the spa. Matching nothing is the common case and not a failure, which
 * is why it logs quietly rather than warning.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  const order = payload as any;
  const orderId =
    order?.admin_graphql_api_id ??
    (order?.id ? `gid://shopify/Order/${order.id}` : null);

  if (!orderId) {
    console.warn(`[${topic}] ${shop}: no order id in payload, nothing to do`);
    return new Response();
  }

  // An order raised from a draft carries the draft's id. Both spellings are
  // read because the REST payload and the GraphQL id differ in shape, and an
  // order that came from no draft simply has neither.
  const draftIds: string[] = [];
  if (order?.admin_graphql_api_draft_order_id) {
    draftIds.push(order.admin_graphql_api_draft_order_id);
  }
  if (order?.draft_order_id) {
    draftIds.push(`gid://shopify/DraftOrder/${order.draft_order_id}`);
  }

  if (draftIds.length === 0) {
    console.log(`[${topic}] ${shop}: ${orderId} did not come from a draft order, nothing to reconcile`);
    return new Response();
  }

  const reconciled = await reconcilePaidOrder(pool, {
    shopifyOrderId: orderId,
    draftOrderIds: draftIds,
  });

  if (reconciled.length === 0) {
    console.log(`[${topic}] ${shop}: ${orderId} matched no work order`);
  } else {
    console.log(`[${topic}] ${shop}: ${orderId} settled work order(s) ${reconciled.join(', ')}`);
  }

  return new Response();
};
