import type { LoaderFunctionArgs } from 'react-router';
import pool from '../db.server.ts';
import { getCloset } from '../lib/db.ts';
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

    return json({
      signedIn: true,
      membership: closet.membership
        ? {
            tier: closet.membership.tier,
            status: closet.membership.status,
            renewsOn: closet.membership.membershipYearEnd.toISOString(),
            nextBillingAt: closet.membership.nextBillingAt?.toISOString() ?? null,
            servicesRemaining: closet.allowanceRemaining,
          }
        : null,
      wigs: closet.wigs,
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
