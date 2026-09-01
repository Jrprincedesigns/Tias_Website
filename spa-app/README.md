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
| App proxy endpoints (`/apps/spa/*`) | The storefront — Wig Closet, wig registration, photo uploads, service requests |
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
   at this app's deployment root. Shopify forwards `/apps/spa/<rest>` to
   `<url>/<rest>` with a `signature` and, for logged-in visitors,
   `logged_in_customer_id`. Do not add a path suffix to the proxy URL —
   `shopify app dev` overwrites it with the bare tunnel host each run.

3. **Create the Supabase project** and apply `supabase/migrations` in order. RLS
   is on with no permissive policies — reads and writes go through the service
   role from this app only, so a leaked anon key exposes nothing.

   Apply them by pasting each file into the SQL editor, or with the CLI:

   ```
   brew install supabase/tap/supabase
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```

   `0002` creates the private `wig-photos` bucket. The Supabase CLI has no
   bucket-create command, but buckets are just rows in `storage.buckets`, so it
   lives in a migration and reproduces on a fresh project. The file is guarded
   on the storage schema existing, so it is a no-op against a plain PostgreSQL
   instance — which is what the integration tests run against.

4. **Set the environment** (see `.env.example`).

## Running the checks

```
npm test
npm run typecheck
npm run build
```

Source is TypeScript run directly by Node's type stripping — no build step for
tests. `tsc` runs in `--noEmit` mode purely as a checker.

`npm test` alone runs the unit tests: signature verification (including
impersonation and forged-signature attempts), the status machine, the
allowance rules, and intake validation.

The integration tests need a real PostgreSQL — mocks accept SQL the database
rejects, which is how the missing enum casts in `advanceStatus` were found. They
skip when `TEST_DATABASE_URL` is unset:

```
createdb wigspa && psql -d wigspa -f ../supabase/migrations/0001_wig_spa_core.sql
TEST_DATABASE_URL=postgresql://localhost/wigspa npm test
```

Note the role you connect as must bypass row level security, the way Supabase's
`service_role` does — every table has RLS on with no permissive policies, so an
ordinary role reads nothing and the tests fail in a confusing way. Locally:
`alter role <you> bypassrls;`

Tests run with `--test-concurrency=1` because the integration files share one
database and truncate between cases.

## Phase 0 — proving the storefront can reach this app

Under new customer accounts the account portal runs on a different origin from
the storefront, and everything the Wig Closet does assumes a signed-in visitor
still arrives here with an identity Shopify vouches for. `sections/tc-phase0-probe.liquid`
in the theme tests that chain and prints a verdict per link.

1. `npm run dev` here (`shopify app dev`) — note the tunnel URL it prints.
2. Set `DATABASE_URL` in `.env` to the Supabase **pooler** string (port 6543).
3. In Shopify admin, create a page using the **page.phase0** template on the
   duplicated unpublished theme.
4. Sign in on the storefront, open that page, read the four rows.

A and C decide the architecture. B and D are configuration:

- **B fails** — nothing at `/apps/spa`. Check that `shopify app dev` is still
  running and that its tunnel URL matches `app_proxy.url`. The proxy endpoints
  live at the app root (`whoami.ts`, `closet.ts`, `service-request.ts`) because
  the CLI sets `app_proxy.url` to the bare tunnel host on every run.
- **D fails** — `DATABASE_URL` is unset or pointed at direct Postgres rather
  than the pooler.

Delete `sections/tc-phase0-probe.liquid` and `templates/page.phase0.json` once
the answer is recorded. `/apps/spa/whoami` is worth keeping — it reads no
database, so it isolates a Shopify problem from a Supabase one.

## The app will not start without DATABASE_URL

`app/shopify.server.ts` throws at boot when it is missing, by design — the
alternative is an opaque URL parse error deep in the session store. If
`shopify app dev` reports "App isn't responding yet" and then gives up, an
unset `DATABASE_URL` is the first thing to check.

## Two things that will bite

- **Uninstalling this app deletes the selling plans 48 hours later.** Shopify
  removes `SellingPlanGroup` records belonging to an uninstalled subscriptions
  app. Live memberships depend on this app staying installed.

  Two things guard this, and neither prevents it — they buy time and lower the
  odds:

  1. **The uninstall webhook raises an alert.** Set `ALERT_WEBHOOK_URL` to a
     Slack/Discord incoming webhook or any endpoint that can reach a phone.
     Without it the alert only reaches the logs, which is where this problem
     went unnoticed by design. Reinstalling inside the 48-hour window costs
     nothing; outside it, every member's billing has nothing left to bill
     against.
  2. **Restrict who can uninstall.** In Shopify admin, staff need the *Apps*
     permission to remove an app. Limit it to the store owner: Settings →
     Users and permissions → the staff member → uncheck *Manage and install
     apps*. Nothing in this repo can enforce that.

- **Webhook bodies must be verified against raw bytes.** Parsing the JSON and
  re-serialising it changes the bytes and the HMAC will not match. There is a
  test for exactly this.

## Deployment note

This lives in the theme repository, which Shopify's GitHub integration syncs
to the live theme — and Shopify auto-commits every theme-editor edit to
`main`. Set Vercel's root directory to `spa-app` and configure an ignored
build step, or the app redeploys every time a section is nudged in the theme
editor.
