import crypto from 'node:crypto';

/**
 * Whether a request comes from Vercel Cron (vercel.json).
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET`. Without the secret set,
 * this refuses everything rather than running a job for anyone who asks.
 */
export function cronAuthorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
