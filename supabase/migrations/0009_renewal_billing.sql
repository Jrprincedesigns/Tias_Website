-- Charging membership renewals.
--
-- The app owns its subscription contracts, and Shopify bills an app-owned
-- contract only when the app asks it to. The daily job asks once per billing
-- cycle, and again on the dunning schedule if the charge fails. The rules —
-- which cycle is due, when to retry, when to give up — live in
-- spa-app/app/lib/renewal-billing.ts. This is where each request is written
-- down before it reaches Shopify.
--
-- One row per charge the app has asked Shopify for. The unique key on
-- (contract, cycle, attempt) is what stops two overlapping runs, or a retried
-- one, from charging the same cycle twice: a run claims the row first, and
-- only the run that inserted it calls Shopify.
create table if not exists billing_attempts (
  id                  uuid primary key default gen_random_uuid(),
  membership_id       uuid not null references memberships(id) on delete cascade,
  shop                text not null,
  shopify_contract_id text not null,
  -- Shopify's billing cycle index: 1 is the first renewal after checkout.
  cycle_index         integer not null check (cycle_index >= 1),
  -- 1 for the charge on the due date, 2 and up for dunning retries.
  attempt_number      integer not null check (attempt_number >= 1),
  idempotency_key     text not null unique,
  status              text not null default 'requested'
                        check (status in ('requested', 'succeeded', 'failed', 'challenged')),
  -- Filled in from the charge mutation's response; the outcome webhooks are
  -- matched on it.
  shopify_attempt_id  text unique,
  shopify_order_id    text,
  error_code          text,
  error_message       text,
  requested_at        timestamptz not null default now(),
  resolved_at         timestamptz,
  unique (shopify_contract_id, cycle_index, attempt_number)
);

comment on table billing_attempts is
  'Renewal charges the app asked Shopify for, one row per attempt. Claimed before the request is sent.';

create index if not exists billing_attempts_contract_idx
  on billing_attempts (shopify_contract_id, cycle_index, attempt_number);

-- Like every other table: no policies, so only the service role reads it.
alter table billing_attempts enable row level security;
