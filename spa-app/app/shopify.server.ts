import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PostgreSQLSessionStorage } from "@shopify/shopify-app-session-storage-postgresql";

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // Fail loudly at boot. Without this the session store throws an opaque
    // URL parse error and the app looks like an auth bug instead of a
    // missing environment variable.
    throw new Error("DATABASE_URL is not set — the app cannot reach Supabase");
  }
  return url;
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
  sessionStorage: new PostgreSQLSessionStorage(requireDatabaseUrl()),
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
