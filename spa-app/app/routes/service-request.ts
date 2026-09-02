import type { ActionFunctionArgs } from 'react-router';
import pool from '../db.server.ts';
import {
  createServiceRequest,
  findOrCreateMember,
  getAllowanceEntries,
  getMembership,
  recordIntakePhotos,
} from '../lib/db.ts';
import { decideCoverage } from '../lib/allowance.ts';
import { json, proxyError, withProxyAuth } from '../lib/proxy.ts';
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
    if (request.method !== 'POST') return proxyError('method_not_allowed', 405);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return proxyError('invalid_json', 400);
    }

    const parsed = parseIntake(body);
    if (!parsed.ok) {
      // Validation messages are the caller's own mistakes, so they travel in
      // the body rather than behind the debug flag.
      return json({ ok: false, error: 'invalid_request', httpStatus: 422, details: parsed.errors });
    }
    const intake = parsed.value;

    const member = await findOrCreateMember(pool, {
      shop: customer.shop,
      shopifyCustomerId: customer.shopifyCustomerId,
    });

    // Ownership check. The wig must be this member's, and not retired.
    const owned = await pool.query(
      `select id from wigs where id = $1 and member_id = $2 and retired_at is null`,
      [intake.wigId, member.id],
    );
    if (owned.rowCount === 0) {
      // Deliberately the same shape as "no such wig". Telling an attacker that
      // a wig exists but belongs to someone else is a free membership lookup.
      return proxyError('unknown_wig', 404);
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

    // Storage paths come from the browser. recordIntakePhotos verifies every
    // one begins with this member's own prefix and refuses the whole batch if
    // any does not, so a stranger's photograph cannot be attached by editing a
    // string.
    const photoPaths = Array.isArray((body as { photoPaths?: unknown }).photoPaths)
      ? ((body as { photoPaths: unknown[] }).photoPaths.filter(
          (p): p is string => typeof p === 'string',
        ))
      : [];

    const created = await createServiceRequest(pool, {
      memberId: member.id,
      wigId: intake.wigId,
      membershipId: membership?.id ?? null,
      serviceType: intake.serviceType,
      coveredByAllowance: decision.covered,
      intake: intake.answers,
      customerNotes: intake.notes,
    });

    let photosAttached = 0;
    try {
      photosAttached = await recordIntakePhotos(pool, {
        memberId: member.id,
        wigId: intake.wigId,
        serviceRequestId: created.id,
        storagePaths: photoPaths,
      });
    } catch (error) {
      // The request itself is already saved and is the thing that matters — a
      // wig on its way to the studio must not be lost because a photo path was
      // wrong. Report it rather than failing the submission.
      console.error('[service-request] photos rejected:', error);
    }

    return json(
      {
        ok: true,
        id: created.id,
        photosAttached,
        status: created.status,
        coveredByAllowance: decision.covered,
        // Why it isn't covered, so the page can say something useful instead
        // of just showing a price.
        coverageReason: decision.covered ? null : decision.reason,
        httpStatus: 201,
      },
    );
  });
