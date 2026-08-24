import crypto from 'node:crypto';

/**
 * Verifying that a request genuinely came from Shopify.
 *
 * Two different schemes, and they are not interchangeable:
 *
 *   App proxy  — storefront requests forwarded by Shopify. Query parameters
 *                are sorted and concatenated, and the digest arrives as the
 *                `signature` parameter. This is what carries
 *                `logged_in_customer_id`, which is the only trustworthy
 *                statement of who is asking. A customer id in a request body
 *                is a claim; this one is a fact.
 *
 *   Webhook    — server-to-server POSTs. The digest is base64 over the raw
 *                request body and arrives in `X-Shopify-Hmac-Sha256`. It must
 *                be computed over the exact bytes received, so the body has to
 *                be read before any JSON parsing.
 */

/** Constant-time compare that never throws on length mismatch. */
function safeEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify an app-proxy request.
 *
 * @param {URLSearchParams|Record<string,string|string[]>} query
 * @param {string} secret  the app's client secret
 * @returns {boolean}
 */
export function verifyProxySignature(query, secret) {
  const params = query instanceof URLSearchParams ? query : new URLSearchParams(query);

  const signature = params.get('signature');
  if (!signature) return false;

  // Shopify sorts the remaining parameters and joins them without separators.
  // Repeated keys are comma-joined, which is why we collect values per key
  // rather than using the first one.
  const grouped = new Map();
  for (const [key, value] of params.entries()) {
    if (key === 'signature') continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(value);
  }

  const message = [...grouped.keys()]
    .sort()
    .map((key) => `${key}=${grouped.get(key).join(',')}`)
    .join('');

  const digest = crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex');
  return safeEqual(digest, signature);
}

/**
 * The signed-in customer, or null for a logged-out visitor.
 *
 * Returns null rather than throwing when the visitor is anonymous — that is a
 * normal state, not an error. Throws only when the signature itself fails,
 * because that means someone is forging requests.
 */
export function customerFromProxyRequest(url, secret) {
  const { searchParams } = new URL(url);

  if (!verifyProxySignature(searchParams, secret)) {
    throw new Error('Invalid app proxy signature');
  }

  const id = searchParams.get('logged_in_customer_id');
  if (!id) return null;

  return { shopifyCustomerId: `gid://shopify/Customer/${id}` };
}

/**
 * Verify a webhook. `rawBody` must be the unparsed body — a re-serialised
 * object will not produce the same digest.
 */
export function verifyWebhookHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  return safeEqual(digest, hmacHeader);
}
