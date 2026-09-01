import { customerFromProxyRequest, type ProxyCustomer } from './shopify-auth.ts';

/**
 * Shared handling for app-proxy endpoints.
 *
 * Every response leaves here as HTTP 200, with the real outcome carried in the
 * body. That is not laziness about status codes — Shopify's proxy discards the
 * body of any non-2xx response and substitutes its own "There was an error in
 * the third-party application" page. A 500 that carefully explains itself
 * reaches the customer as a blank wall, and the storefront cannot tell a
 * misconfigured server from a lost connection.
 *
 * So the transport always succeeds and the payload tells the truth:
 *
 *   { ok: true,  ... }                     the handler's data
 *   { ok: true,  signedIn: false }         a normal anonymous visitor
 *   { ok: false, error: 'invalid_signature' }
 *   { ok: false, error: 'app_misconfigured' | 'server_error', detail? }
 *
 * `httpStatus` rides along in error bodies so logs and tests can still see
 * what the status would have been. It is deliberately not called `status` —
 * that name already means a work order's status elsewhere in these payloads.
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

/**
 * An error payload the storefront can actually read.
 *
 * Always HTTP 200 — see the note at the top of this file. `status` records the
 * status this would have been so the intent is not lost.
 */
export function proxyError(
  error: string,
  status: number,
  detail?: string,
): Response {
  return json({
    ok: false,
    error,
    httpStatus: status,
    ...(detail && includeErrorDetail() ? { detail } : {}),
  });
}

/** Wraps a handler so every failure comes back as readable JSON. */
export async function withProxyAuth(
  request: Request,
  handler: (customer: ProxyCustomer) => Promise<Response>,
): Promise<Response> {
  try {
    const customer = authenticateProxy(request);

    if (!customer) return json({ ok: true, signedIn: false });

    return await handler(customer);
  } catch (error) {
    if (error instanceof ProxyAuthError) {
      return proxyError('invalid_signature', 401);
    }

    // Anything else is ours, not the caller's. Log the whole thing for the
    // terminal, and hand the page something it can render a real message from.
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[app proxy] request failed:', error);

    return proxyError(
      error instanceof ProxyConfigError ? 'app_misconfigured' : 'server_error',
      500,
      detail,
    );
  }
}
