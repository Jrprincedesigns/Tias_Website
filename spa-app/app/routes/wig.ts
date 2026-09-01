import type { LoaderFunctionArgs } from 'react-router';
import pool from '../db.server.ts';
import { findOrCreateMember, getWigDetail } from '../lib/db.ts';
import { createViewUrls } from '../lib/storage.ts';
import { json, proxyError, withProxyAuth } from '../lib/proxy.ts';

/**
 * GET /apps/spa/wig?id=<uuid> — one unit, expanded.
 *
 * The id arrives from the browser, so it is checked against the member Shopify
 * vouched for rather than trusted. A wig that is not theirs and a wig that does
 * not exist get the same answer on purpose: distinguishing them would confirm
 * an id belongs to somebody.
 *
 * Photos are private, so each one is handed over as a short-lived signed URL
 * rather than a path the browser could reuse. Signing is best-effort: a photo
 * that will not sign comes back with a null url and the panel shows its
 * placeholder, which is better than failing the whole unit over one image.
 */
export const loader = async ({ request }: LoaderFunctionArgs) =>
  withProxyAuth(request, async (customer) => {
    const wigId = new URL(request.url).searchParams.get('id');
    if (!wigId) return proxyError('missing_wig_id', 400);

    // Cheap shape check before the query — a malformed id is a caller error,
    // not a database round trip.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wigId)) {
      return proxyError('invalid_wig_id', 400);
    }

    const member = await findOrCreateMember(pool, { shopifyCustomerId: customer.shopifyCustomerId });
    const detail = await getWigDetail(pool, member.id, wigId);
    if (!detail) return json({ ok: true, signedIn: true, found: false });

    // One batch call for the profile shot and the gallery together.
    const signed = await createViewUrls([
      detail.wig.photoPath,
      ...detail.photos.map((photo) => photo.storagePath),
    ].filter((path): path is string => Boolean(path)));

    return json({
      ok: true,
      signedIn: true,
      found: true,
      wig: {
        ...detail.wig,
        photoUrl: detail.wig.photoPath ? signed.get(detail.wig.photoPath) ?? null : null,
      },
      services: detail.services.map((service) => ({
        id: service.id,
        serviceType: service.serviceType,
        status: service.status,
        coveredByAllowance: service.coveredByAllowance,
        customerNotes: service.customerNotes,
        studioNotes: service.studioNotes,
        submittedAt: service.submittedAt.toISOString(),
        receivedAt: service.receivedAt?.toISOString() ?? null,
        completedAt: service.completedAt?.toISOString() ?? null,
        events: service.events.map((event) => ({
          kind: event.kind,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          at: event.createdAt.toISOString(),
        })),
        inspection: service.inspection
          ? {
              assessment: service.inspection.assessment,
              recommendedWork: service.inspection.recommendedWork,
              additionalCostCents: service.inspection.additionalCostCents,
              currency: service.inspection.currency,
              customerApproved: service.inspection.customerApproved,
              respondedAt: service.inspection.customerRespondedAt?.toISOString() ?? null,
            }
          : null,
      })),
      photos: detail.photos.map((photo) => ({
        id: photo.id,
        kind: photo.kind,
        caption: photo.caption,
        url: signed.get(photo.storagePath) ?? null,
        at: photo.createdAt.toISOString(),
      })),
    });
  });
