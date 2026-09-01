import type { ActionFunctionArgs } from "react-router";
import { authenticate, sessionStorage } from "../shopify.server";
import { sendAlert } from "../lib/alerts";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  // This is the loudest thing the app ever has to say.
  //
  // Shopify deletes an app's selling plan groups roughly 48 hours after it is
  // uninstalled, and live memberships depend on them. Inside that window,
  // reinstalling costs nothing. Outside it, the plans are gone and every
  // member's recurring billing has nothing left to bill against.
  //
  // Uninstalling is two clicks in admin with no warning that anything is
  // load-bearing, so the alert is the only thing standing between a misclick
  // and finding out when a card is not charged.
  await sendAlert({
    event: "app_uninstalled",
    summary:
      `The Wig Spa app was uninstalled from ${shop}. Reinstall within 48 hours ` +
      `or Shopify deletes the membership selling plans and live memberships stop billing.`,
    detail: { shop, topic },
  });

  // Webhook requests can fire more than once, and can arrive after the app is
  // already gone, so the session may have been cleared by an earlier delivery.
  if (session) {
    const sessions = await sessionStorage.findSessionsByShop(shop);
    if (sessions.length > 0) {
      await sessionStorage.deleteSessions(sessions.map((s) => s.id));
    }
  }

  return new Response();
};
