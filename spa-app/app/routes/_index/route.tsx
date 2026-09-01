import type { LoaderFunctionArgs } from 'react-router';
import { redirect } from 'react-router';

/**
 * The app root.
 *
 * Nothing about this app is meant to be browsed directly. Members reach it
 * only through the storefront, where Shopify signs each request and forwards
 * /apps/spa/<rest> here; Tia reaches it embedded in the Shopify admin. The
 * scaffold shipped a marketing page here with placeholder copy and a shop-
 * domain login form, which — once the app had a real hostname instead of a
 * throwaway tunnel — published "[your app]" boilerplate and an OAuth entry
 * point on a T Collection subdomain.
 *
 * So the root is a signpost, not a page.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // Shopify opens the embedded app by loading the root with ?shop=. This is
  // the admin entry point and has to keep working — it is why this loader
  // still exists rather than the route being deleted outright.
  if (url.searchParams.get('shop')) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  // Anyone else is a person who typed the hostname. Send them to the shop.
  // Installing on a store goes through /auth/login, which has its own form.
  return redirect('https://thetcollection.shop');
};
