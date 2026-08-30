import type { ActionFunctionArgs } from 'react-router';
import pool from '../db.server.ts';
import { findOrCreateMember, registerWig } from '../lib/db.ts';
import { parseWigRegistration } from '../lib/intake.ts';
import { json, proxyError, withProxyAuth } from '../lib/proxy.ts';

/**
 * POST /apps/spa/wigs — register a unit.
 *
 * Called inline from the send-a-wig form: a member sending their first unit
 * should not have to complete a separate registration first. The member comes
 * from Shopify's signed request, never from the body.
 */
export const action = async ({ request }: ActionFunctionArgs) =>
  withProxyAuth(request, async (customer) => {
    if (request.method !== 'POST') return proxyError('method_not_allowed', 405);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return proxyError('invalid_json', 400);
    }

    const parsed = parseWigRegistration(body);
    if (!parsed.ok) {
      return json({ ok: false, error: 'invalid_request', httpStatus: 422, details: parsed.errors });
    }

    const member = await findOrCreateMember(pool, { shopifyCustomerId: customer.shopifyCustomerId });
    const wig = await registerWig(pool, { memberId: member.id, ...parsed.value });

    return json({ ok: true, wig, httpStatus: 201 });
  });
