import type { LoaderFunctionArgs } from 'react-router';
import pool from '../db.server.ts';
import { getCloset } from '../lib/db.ts';
import { createViewUrls } from '../lib/storage.ts';
import { json, withProxyAuth } from '../lib/proxy.ts';

/**
 * GET /apps/spa/closet — everything the Wig Closet renders.
 *
 * The customer is taken from Shopify's signed `logged_in_customer_id` and
 * never from the request body or a query parameter the page supplied. That is
 * the whole reason this endpoint is safe to expose to a browser.
 */
export const loader = async ({ request }: LoaderFunctionArgs) =>
  withProxyAuth(request, async (customer) => {
    const closet = await getCloset(pool, customer.shopifyCustomerId);

    // Unit cards lead with the wig's photograph, so the grid needs signed URLs
    // too — not just the detail panel. One batch call covers the whole closet.
    const signed = await createViewUrls(
      closet.wigs.map((wig) => wig.photoPath).filter((path): path is string => Boolean(path)),
    );

    return json({
      ok: true,
      signedIn: true,
      membership: closet.membership
        ? {
            tier: closet.membership.tier,
            status: closet.membership.status,
            renewsOn: closet.membership.membershipYearEnd.toISOString(),
            nextBillingAt: closet.membership.nextBillingAt?.toISOString() ?? null,
            // What the membership is actually worth to them. Membership no
            // longer includes services, so the count below is legacy: it is
            // still sent for anyone whose ledger has entries, and the page
            // only shows it when it is above zero.
            discountPercent: closet.membership.discountPercent,
            servicesRemaining: closet.allowanceRemaining,
          }
        : null,
      wigs: closet.wigs.map((wig) => ({
        ...wig,
        photoUrl: wig.photoPath ? signed.get(wig.photoPath) ?? null : null,
      })),
      activeServices: closet.activeServices.map((service) => ({
        id: service.id,
        wigId: service.wigId,
        wigNickname: service.wigNickname,
        serviceType: service.serviceType,
        status: service.status,
        coveredByAllowance: service.coveredByAllowance,
        submittedAt: service.submittedAt.toISOString(),
      })),
    });
  });
