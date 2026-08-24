# The Wig Spa app

Service-management app behind The Wig Spa Membership. Shopify stays the
commerce engine (products, subscription contracts, orders, draft orders,
payments); this app owns everything Shopify has no concept of — which unit a
member owns, what has been done to it, what their membership still entitles
them to, and where the unit currently sits in the studio.

It serves three surfaces:

| Surface | Who it's for |
|---|---|
| Embedded admin (Shopify sidebar) | Tia — the work queue, status, notes, photos, approvals |
| App proxy endpoints (`/apps/spa/*`) | The storefront — Wig Closet and service requests |
| Webhook handlers | Shopify — subscription and order state |

## Why it can't be a theme

Liquid can read `customer.metafields`; it cannot write anything. Every wig
profile, allowance decrement and status change needs a signed, server-side
write. That is this app.

## Setup

Nothing here is store-specific, but four things must exist before it runs.

1. **Create the app in the Shopify Dev/Partner Dashboard** with custom
   distribution, installed on `theetcollection.myshopify.com`. It must be
   created there, not under admin → *Develop apps* — that flavour of custom
   app has no app-proxy configuration.

2. **Configure the app proxy**: subpath prefix `apps`, subpath `spa`, pointing
   at this app's deployment. Shopify then forwards storefront requests with a
   `signature` and, for logged-in visitors, `logged_in_customer_id`.

3. **Create the Supabase project** and apply `supabase/migrations`. RLS is on
   with no permissive policies — reads and writes go through the service role
   from this app only, so a leaked anon key exposes nothing.

4. **Set the environment** (see `.env.example`).

## Running the checks

```
npm test
```

Covers app-proxy and webhook signature verification (including impersonation
and forged-signature attempts) and the service status machine.

## Two things that will bite

- **Uninstalling this app deletes the selling plans 48 hours later.** Shopify
  removes `SellingPlanGroup` records belonging to an uninstalled subscriptions
  app. Live memberships depend on this app staying installed.

- **Webhook bodies must be verified against raw bytes.** Parsing the JSON and
  re-serialising it changes the bytes and the HMAC will not match. There is a
  test for exactly this.

## Deployment note

This lives in the theme repository, which Shopify's GitHub integration syncs
to the live theme — and Shopify auto-commits every theme-editor edit to
`main`. Set Vercel's root directory to `spa-app` and configure an ignored
build step, or the app redeploys every time a section is nudged in the theme
editor.
