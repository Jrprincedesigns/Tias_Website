import type { LoaderFunctionArgs } from 'react-router';
import { cronAuthorised } from '../cron-auth.server.ts';
import pool from '../db.server.ts';
import { endLapsedMemberships } from '../lib/membership-cancellation.ts';
import { shopAdmin } from '../shop-admin.server.ts';

/**
 * GET /cron/memberships — daily, from Vercel Cron (vercel.json).
 *
 * Ends memberships whose members cancelled from the closet once the date they
 * paid through has passed: the member tags come off, and the membership stops
 * counting as active. Until this runs they keep what they paid for.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` (cron-auth.server.ts).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!cronAuthorised(request)) return new Response('Unauthorized', { status: 401 });

  const result = await endLapsedMemberships(pool, shopAdmin.forShop);
  for (const failure of result.failed) {
    console.error(`[cron/memberships] could not end ${failure.membershipId}: ${failure.error}`);
  }
  console.log(`[cron/memberships] ended ${result.closed.length}, failed ${result.failed.length}`);

  return Response.json(result, { status: result.failed.length > 0 ? 500 : 200 });
};
