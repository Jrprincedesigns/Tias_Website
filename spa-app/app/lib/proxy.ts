import { customerFromProxyRequest, type ProxyCustomer } from './shopify-auth.ts';

/**
 * Shared handling for app-proxy endpoints.
 *
 * Storefront requests arrive here already signed by Shopify. Three outcomes,
 * and they are deliberately different:
 *
 *   forged signature  → 401. Someone is fabricating requests.
 *   valid, logged out → 200 with signedIn:false. A normal anonymous visitor,
 *                       not an error; the page renders a sign-in prompt.
 *   valid, signed in  → the handler runs with a customer id Shopify vouched for.
 */

export class ProxyAuthError extends Error {
  readonly status = 401;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Proxy responses are per-customer. Any shared cache in front of this
      // would serve one member's closet to another.
      'Cache-Control': 'private, no-store',
    },
  });
}

function appSecret(): string {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error('SHOPIFY_API_SECRET is not set — proxy requests cannot be verified');
  return secret;
}

/**
 * Returns the signed-in customer, or null when the visitor is anonymous.
 * Throws ProxyAuthError when the signature does not verify.
 */
export function authenticateProxy(request: Request): ProxyCustomer | null {
  try {
    return customerFromProxyRequest(request.url, appSecret());
  } catch (error) {
    if (error instanceof Error && error.message.includes('Invalid app proxy signature')) {
      throw new ProxyAuthError('Invalid app proxy signature');
    }
    throw error;
  }
}

/** Wraps a handler so auth failures become responses rather than 500s. */
export async function withProxyAuth(
  request: Request,
  handler: (customer: ProxyCustomer) => Promise<Response>,
): Promise<Response> {
  let customer: ProxyCustomer | null;
  try {
    customer = authenticateProxy(request);
  } catch (error) {
    if (error instanceof ProxyAuthError) return json({ error: 'invalid_signature' }, 401);
    throw error;
  }

  if (!customer) return json({ signedIn: false });

  return handler(customer);
}
