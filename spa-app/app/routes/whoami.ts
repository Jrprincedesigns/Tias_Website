import type { LoaderFunctionArgs } from 'react-router';
import { json, withProxyAuth } from '../lib/proxy.ts';

/**
 * GET /apps/spa/whoami — the diagnostic behind the Phase 0 probe.
 *
 * Answers one question: does a storefront request arrive here carrying a
 * customer Shopify has vouched for? Under new customer accounts the portal
 * lives on a different origin, and whether the storefront session survives
 * the trip through the proxy is the assumption the Wig Closet rests on.
 *
 * Safe to leave in place. A caller learns only what they already know — their
 * own id, and which shop they are on. It reads nothing from the database, so
 * it isolates the Shopify half of the chain from the Supabase half.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  return withProxyAuth(request, async (customer) =>
    json({
      ok: true,
      signatureValid: true,
      signedIn: true,
      shopifyCustomerId: customer.shopifyCustomerId,
      shop: url.searchParams.get('shop'),
      // Echoed back so the probe can show the path Shopify actually forwarded,
      // which is the fastest way to spot a misconfigured proxy url.
      path: url.pathname,
    }),
  );
};
