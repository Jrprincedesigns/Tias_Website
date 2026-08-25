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

/** The app is misconfigured — distinct from a bad request. */
export class ProxyConfigError extends Error {
  readonly status = 500;
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
  if (!secret) {
    throw new ProxyConfigError(
      'SHOPIFY_API_SECRET is not set, so proxy signatures cannot be verified',
    );
  }
  return secret;
}

/**
 * Whether to put error detail in the response body.
 *
 * Off by default: these endpoints are reachable from any storefront visitor,
 * and internal error text is not something to hand out. On in development,
 * where an opaque "error in the third-party application" page costs more than
 * the disclosure does.
 */
function includeErrorDetail(): boolean {
  return process.env.WIG_SPA_DEBUG_ERRORS === 'true' || process.env.NODE_ENV === 'development';
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
  try {
    const customer = authenticateProxy(request);

    if (!customer) return json({ signedIn: false });

    return await handler(customer);
  } catch (error) {
    if (error instanceof ProxyAuthError) {
      return json({ error: 'invalid_signature' }, 401);
    }

    // Anything else is ours, not the caller's. Shopify renders a bare "error
    // in the third-party application" page for an uncaught throw, which tells
    // whoever is debugging nothing at all — so answer with JSON that names the
    // problem, and log the full error for the terminal.
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[app proxy] request failed:', error);

    return json(
      {
        error: error instanceof ProxyConfigError ? 'app_misconfigured' : 'server_error',
        ...(includeErrorDetail() ? { detail } : {}),
      },
      500,
    );
  }
}
