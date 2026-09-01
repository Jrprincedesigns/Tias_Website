import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PostgreSQLSessionStorage } from "@shopify/shopify-app-session-storage-postgresql";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { databaseUrl } from "./db.server";

/**
 * Session storage that connects on first use, not at import.
 *
 * Building the store eagerly meant an unset DATABASE_URL threw while the
 * module graph was still loading, which killed the entire server — every
 * route, including the ones that never touch the database. Deferring it lets
 * the app boot and answer, and lets the routes that genuinely need Postgres
 * be the only ones that fail.
 */
function lazySessionStorage(): SessionStorage {
  let store: PostgreSQLSessionStorage | undefined;
  const connected = () => (store ??= new PostgreSQLSessionStorage(databaseUrl()));

  return {
    storeSession: (session) => connected().storeSession(session),
    loadSession: (id) => connected().loadSession(id),
    deleteSession: (id) => connected().deleteSession(id),
    deleteSessions: (ids) => connected().deleteSessions(ids),
    findSessionsByShop: (shop) => connected().findSessionsByShop(shop),
  };
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  // Sessions live in Supabase Postgres, not the template's SQLite file.
  // Vercel's filesystem is ephemeral, so a SQLite session store loses every
  // session on deploy.
  // The store creates its own session table on first connect, so there is no
  // migration to run for it.
  sessionStorage: lazySessionStorage(),
  // Custom distribution — installed on one store, not listed on the App
  // Store. The template ships AppStore, which changes how auth behaves.
  distribution: AppDistribution.SingleMerchant,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
