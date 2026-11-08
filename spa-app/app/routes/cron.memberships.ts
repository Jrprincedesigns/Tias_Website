import type { LoaderFunctionArgs } from 'react-router';
import { cronAuthorised } from '../cron-auth.server.ts';
import pool from '../db.server.ts';
import { carryOutCancelRequests, endLapsedMemberships } from '../lib/membership-cancellation.ts';
import { shopAdmin } from '../shop-admin.server.ts';

/**
 * GET /cron/memberships — daily, from Vercel Cron (vercel.json).
 *
 * Ends memberships whose members cancelled from the closet once the date they
 * paid through has passed: the member tags come off, and the membership stops
 * counting as active. Until this runs they keep what they paid for.
 *
 * Before that, it carries out cancellations members asked for during their
 * minimum term, once the minimum has been paid. Those are then held open to
 * the paid-through date like any other cancel, so none ends on the same run.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` (cron-auth.server.ts).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!cronAuthorised(request)) return new Response('Unauthorized', { status: 401 });

  const requests = await carryOutCancelRequests(pool, shopAdmin.forShop);
  for (const failure of requests.failed) {
    console.error(`[cron/memberships] could not carry out cancel request ${failure.membershipId}: ${failure.error}`);
  }

  const result = await endLapsedMemberships(pool, shopAdmin.forShop);
  for (const failure of result.failed) {
    console.error(`[cron/memberships] could not end ${failure.membershipId}: ${failure.error}`);
  }
  console.log(
    `[cron/memberships] carried out ${requests.carriedOut.length} cancel request(s), ` +
      `ended ${result.closed.length}, failed ${requests.failed.length + result.failed.length}`,
  );

  const failed = requests.failed.length + result.failed.length > 0;
  return Response.json({ ...result, requests }, { status: failed ? 500 : 200 });
};
