import type { ActionFunctionArgs } from "react-router";
import { authenticate, sessionStorage } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can fire more than once, and can arrive after the app is
  // already gone, so the session may have been cleared by an earlier delivery.
  if (session) {
    const sessions = await sessionStorage.findSessionsByShop(shop);
    if (sessions.length > 0) {
      await sessionStorage.deleteSessions(sessions.map((s) => s.id));
    }
  }

  // Worth knowing: Shopify deletes this app's selling plan groups roughly 48
  // hours after uninstall. Live memberships depend on the app staying
  // installed — reinstalling within that window is the only cheap recovery.

  return new Response();
};
