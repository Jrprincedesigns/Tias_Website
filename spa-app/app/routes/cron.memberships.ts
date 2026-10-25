import crypto from 'node:crypto';
import type { LoaderFunctionArgs } from 'react-router';
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
 * Vercel sends `Authorization: Bearer $CRON_SECRET`. Without the secret set,
 * the endpoint refuses everything rather than running for anyone who asks.
 */
function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!authorised(request)) return new Response('Unauthorized', { status: 401 });

  const result = await endLapsedMemberships(pool, shopAdmin.forShop);
  for (const failure of result.failed) {
    console.error(`[cron/memberships] could not end ${failure.membershipId}: ${failure.error}`);
  }
  console.log(`[cron/memberships] ended ${result.closed.length}, failed ${result.failed.length}`);

  return Response.json(result, { status: result.failed.length > 0 ? 500 : 200 });
};
