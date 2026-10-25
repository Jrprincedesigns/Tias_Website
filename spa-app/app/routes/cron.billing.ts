import type { LoaderFunctionArgs } from 'react-router';
import { cronAuthorised } from '../cron-auth.server.ts';
import pool from '../db.server.ts';
import { chargeDueRenewals } from '../lib/renewal-billing.ts';
import { shopAdmin } from '../shop-admin.server.ts';

/**
 * GET /cron/billing — daily, from Vercel Cron (vercel.json).
 *
 * Charges every membership renewal that has come due, and retries failed ones
 * on the dunning schedule (renewal-billing.ts). Shopify charges an app-owned
 * contract only when the app asks, so without this no member pays past
 * checkout.
 *
 * Safe to run twice, or overlapping: each charge is claimed before it is sent.
 * Vercel sends `Authorization: Bearer $CRON_SECRET` (cron-auth.server.ts).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!cronAuthorised(request)) return new Response('Unauthorized', { status: 401 });

  const result = await chargeDueRenewals(pool, shopAdmin.forShop);
  for (const failure of result.failed) {
    console.error(`[cron/billing] ${failure.shop} ${failure.contractId ?? ''}: ${failure.error}`);
  }
  console.log(
    `[cron/billing] charged ${result.charged.length}, cancelled ${result.cancelled.length}, ` +
      `failed ${result.failed.length}`,
  );

  return Response.json(result, { status: result.failed.length > 0 ? 500 : 200 });
};
