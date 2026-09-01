import type { ActionFunctionArgs } from 'react-router';
import pool from '../db.server.ts';
import { findOrCreateMember, recordInspectionDecision } from '../lib/db.ts';
import { json, proxyError, withProxyAuth } from '../lib/proxy.ts';

/**
 * POST /apps/spa/service-decision — the member answers an inspection.
 *
 * Inspection finds work beyond what was booked, the studio quotes it, and the
 * work order waits on `awaiting_customer_approval`. This is where that wait
 * ends.
 *
 * What it does NOT do is take money. Approving records the decision and moves
 * the work order forward; raising the draft order for the extra cost is a
 * separate step that needs the Shopify Admin API. Splitting it this way means a
 * double-submitted approval cannot double-bill — `already_answered` is a
 * distinct outcome rather than a second write.
 */
export const action = async ({ request }: ActionFunctionArgs) =>
  withProxyAuth(request, async (customer) => {
    if (request.method !== 'POST') return proxyError('method_not_allowed', 405);

    let body: any;
    try {
      body = await request.json();
    } catch {
      return proxyError('invalid_json', 400);
    }

    const serviceRequestId = typeof body?.serviceRequestId === 'string' ? body.serviceRequestId : null;
    const approved = body?.approved;

    if (!serviceRequestId || typeof approved !== 'boolean') {
      return json({
        ok: false,
        error: 'invalid_request',
        httpStatus: 422,
        details: ['serviceRequestId (uuid) and approved (boolean) are required'],
      });
    }

    const member = await findOrCreateMember(pool, { shopifyCustomerId: customer.shopifyCustomerId });
    const outcome = await recordInspectionDecision(pool, {
      memberId: member.id,
      serviceRequestId,
      approved,
    });

    // `not_found` covers both "no such request" and "not yours" — see the note
    // in getWigDetail about not confirming ids that are not the caller's.
    if (outcome === 'not_found') return json({ ok: true, signedIn: true, recorded: false, reason: 'not_found' });
    if (outcome === 'already_answered') {
      return json({ ok: true, signedIn: true, recorded: false, reason: 'already_answered' });
    }

    return json({ ok: true, signedIn: true, recorded: true, approved });
  });
