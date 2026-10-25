import type { AdminClient } from './lib/membership-provisioning.ts';

/**
 * The Admin API client for a store, through its offline session — for the
 * proxy routes and the cron job, which act for a store with no admin user
 * signed in.
 *
 * shopify.server is imported lazily, and `forShop` is replaceable, so tests
 * can run those routes against a real database with a stand-in for Shopify.
 */
export const shopAdmin = {
  forShop: async (shop: string): Promise<AdminClient> => {
    const { unauthenticated } = await import('./shopify.server');
    const { admin } = await unauthenticated.admin(shop);
    return admin;
  },
};
