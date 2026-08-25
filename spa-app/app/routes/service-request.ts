import type { ActionFunctionArgs } from 'react-router';
import pool from '../db.server.ts';
import {
  createServiceRequest,
  findOrCreateMember,
  getAllowanceEntries,
  getMembership,
} from '../lib/db.ts';
import { decideCoverage } from '../lib/allowance.ts';
import { json, withProxyAuth } from '../lib/proxy.ts';
import { parseIntake } from '../lib/intake.ts';

/**
 * POST /apps/spa/service-request — a member sends a wig in.
 *
 * The wig id arrives from the browser, so it is verified against the member
 * Shopify vouched for before anything is written. Without that check a member
 * could open a work order against someone else's unit by editing one field.
 */
export const action = async ({ request }: ActionFunctionArgs) =>
  withProxyAuth(request, async (customer) => {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const parsed = parseIntake(body);
    if (!parsed.ok) return json({ error: 'invalid_request', details: parsed.errors }, 422);
    const intake = parsed.value;

    const member = await findOrCreateMember(pool, { shopifyCustomerId: customer.shopifyCustomerId });

    // Ownership check. The wig must be this member's, and not retired.
    const owned = await pool.query(
      `select id from wigs where id = $1 and member_id = $2 and retired_at is null`,
      [intake.wigId, member.id],
    );
    if (owned.rowCount === 0) {
      // Deliberately the same shape as "no such wig". Telling an attacker that
      // a wig exists but belongs to someone else is a free membership lookup.
      return json({ error: 'unknown_wig' }, 404);
    }

    const membership = await getMembership(pool, member.id);
    const entries = membership ? await getAllowanceEntries(pool, membership.id) : [];

    // Coverage is decided here the same way the staff app decides it at
    // approval — one rule, so the badge the member saw and the charge they
    // get cannot disagree. A brand-new request has no id yet, so nothing can
    // have consumed against it.
    const decision = decideCoverage({
      membership,
      entries,
      serviceRequestId: '00000000-0000-0000-0000-000000000000',
    });

    const created = await createServiceRequest(pool, {
      memberId: member.id,
      wigId: intake.wigId,
      membershipId: membership?.id ?? null,
      serviceType: intake.serviceType,
      coveredByAllowance: decision.covered,
      intake: intake.answers,
      customerNotes: intake.notes,
    });

    return json(
      {
        id: created.id,
        status: created.status,
        coveredByAllowance: decision.covered,
        // Why it isn't covered, so the page can say something useful instead
        // of just showing a price.
        coverageReason: decision.covered ? null : decision.reason,
      },
      201,
    );
  });
