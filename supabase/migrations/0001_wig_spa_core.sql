-- The Wig Spa — core service-management schema.
--
-- Shopify remains the commerce truth (customers, products, subscription
-- contracts, orders, payments). This schema is the *service* truth: which
-- units a member owns, what has been done to them, what their membership
-- still entitles them to, and where a unit currently sits in the studio.
--
-- Shopify ids are stored as GIDs (e.g. gid://shopify/Customer/123) because
-- that is what both the Admin API and the app proxy hand us.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------------------
create table members (
  id                  uuid primary key default gen_random_uuid(),
  shopify_customer_id text not null unique,
  email               text,
  first_name          text,
  last_name           text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Memberships
--
-- One row per Shopify subscription contract. Status mirrors the contract and
-- is kept current by webhooks, never by the storefront. `membership_year_*`
-- is what allowances are granted against — it is not the billing period.
-- ---------------------------------------------------------------------------
create type membership_status as enum ('active', 'past_due', 'paused', 'cancelled', 'expired');

create table memberships (
  id                    uuid primary key default gen_random_uuid(),
  member_id             uuid not null references members(id) on delete cascade,
  shopify_contract_id   text unique,
  tier                  text not null,
  status                membership_status not null default 'active',
  membership_year_start date not null,
  membership_year_end   date not null,
  next_billing_at       timestamptz,
  cancelled_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint membership_year_ordered check (membership_year_end > membership_year_start)
);

create index memberships_member_idx on memberships (member_id);
create index memberships_status_idx on memberships (status);

-- ---------------------------------------------------------------------------
-- Wigs — a member's registered units
-- ---------------------------------------------------------------------------
create table wigs (
  id             uuid primary key default gen_random_uuid(),
  member_id      uuid not null references members(id) on delete cascade,
  nickname       text not null,
  is_t_collection boolean not null default false,
  brand          text,
  length_inches  int,
  texture        text,
  color          text,
  lace_type      text,
  cap_size       text,
  purchased_on   date,
  photo_path     text,
  notes          text,
  retired_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint wig_length_sane check (length_inches is null or (length_inches between 1 and 60))
);

create index wigs_member_idx on wigs (member_id) where retired_at is null;

-- ---------------------------------------------------------------------------
-- Service requests — one per unit sent to the studio
--
-- The status ladder is the operational spine. Every transition writes an
-- events row, so "who changed what, when" survives a dispute.
-- ---------------------------------------------------------------------------
create type service_status as enum (
  'requested',
  'awaiting_shipment',
  'in_transit_to_studio',
  'received',
  'inspection',
  'awaiting_customer_approval',
  'approved',
  'in_service',
  'quality_check',
  'ready_to_ship',
  'return_shipment',
  'delivered',
  'completed',
  'cancelled',
  'returned_unserviced'
);

create table service_requests (
  id                   uuid primary key default gen_random_uuid(),
  member_id            uuid not null references members(id) on delete restrict,
  wig_id               uuid not null references wigs(id) on delete restrict,
  membership_id        uuid references memberships(id) on delete set null,
  service_type         text not null,
  status               service_status not null default 'requested',
  covered_by_allowance boolean not null default false,
  intake               jsonb not null default '{}'::jsonb,
  customer_notes       text,
  staff_notes          text,
  shopify_order_id     text,
  submitted_at         timestamptz not null default now(),
  received_at          timestamptz,
  completed_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index service_requests_member_idx on service_requests (member_id, submitted_at desc);
create index service_requests_wig_idx    on service_requests (wig_id, submitted_at desc);
create index service_requests_queue_idx  on service_requests (status, submitted_at);

-- ---------------------------------------------------------------------------
-- Allowance ledger
--
-- Deliberately a ledger, not a counter. Balance is derived by summing
-- `delta`, so a grant, a consumption, a rollover and a manual correction are
-- all visible after the fact. A counter would answer "how many are left" and
-- nothing else; this answers "and why".
-- ---------------------------------------------------------------------------
create type allowance_entry_kind as enum ('grant', 'consumption', 'rollover', 'expiry', 'adjustment');

create table allowance_ledger (
  id                 uuid primary key default gen_random_uuid(),
  membership_id      uuid not null references memberships(id) on delete cascade,
  service_request_id uuid references service_requests(id) on delete set null,
  kind               allowance_entry_kind not null,
  delta              int not null,
  reason             text,
  created_by         text,
  created_at         timestamptz not null default now(),
  constraint allowance_delta_direction check (
    (kind in ('grant', 'rollover') and delta > 0) or
    (kind in ('consumption', 'expiry') and delta < 0) or
    (kind = 'adjustment' and delta <> 0)
  )
);

-- A service request can only ever consume its allowance once, so a retried
-- write cannot silently spend two services.
create unique index allowance_one_consumption_per_request
  on allowance_ledger (service_request_id)
  where kind = 'consumption';

create index allowance_membership_idx on allowance_ledger (membership_id, created_at);

create view membership_allowance_balance as
  select membership_id, coalesce(sum(delta), 0)::int as balance
  from allowance_ledger
  group by membership_id;

-- ---------------------------------------------------------------------------
-- Inspections — arrival documentation and recommended extra work
--
-- Arrival condition is recorded before any work begins. This is the record
-- that answers "it arrived like that", so it is append-only by convention:
-- corrections are a new inspection, not an edit.
-- ---------------------------------------------------------------------------
create table inspections (
  id                    uuid primary key default gen_random_uuid(),
  service_request_id    uuid not null references service_requests(id) on delete cascade,
  arrived_condition     jsonb not null default '{}'::jsonb,
  assessment            text,
  recommended_work      text,
  additional_cost_cents int,
  currency              text not null default 'USD',
  customer_approved     boolean,
  customer_responded_at timestamptz,
  shopify_draft_order_id text,
  inspected_by          text,
  created_at            timestamptz not null default now(),
  constraint additional_cost_non_negative check (additional_cost_cents is null or additional_cost_cents >= 0)
);

create index inspections_request_idx on inspections (service_request_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Photos — intake, arrival documentation, before/after
--
-- Files live in Supabase Storage; this table holds the path plus who it is
-- allowed to be shown to. Customer-visible is opt-in, not the default.
-- ---------------------------------------------------------------------------
create type photo_kind as enum ('intake', 'arrival', 'in_progress', 'before', 'after', 'wig_profile');

create table photos (
  id                 uuid primary key default gen_random_uuid(),
  member_id          uuid not null references members(id) on delete cascade,
  wig_id             uuid references wigs(id) on delete set null,
  service_request_id uuid references service_requests(id) on delete cascade,
  kind               photo_kind not null,
  storage_path       text not null unique,
  caption            text,
  customer_visible   boolean not null default false,
  uploaded_by        text,
  created_at         timestamptz not null default now()
);

create index photos_request_idx on photos (service_request_id, kind);

-- ---------------------------------------------------------------------------
-- Shipments — inbound and outbound legs
-- ---------------------------------------------------------------------------
create type shipment_direction as enum ('inbound', 'outbound');

create table shipments (
  id                 uuid primary key default gen_random_uuid(),
  service_request_id uuid not null references service_requests(id) on delete cascade,
  direction          shipment_direction not null,
  carrier            text,
  tracking_number    text,
  tracking_url       text,
  declared_value_cents int,
  shipped_at         timestamptz,
  delivered_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index shipments_request_idx on shipments (service_request_id, direction);

-- ---------------------------------------------------------------------------
-- Events — append-only audit trail
-- ---------------------------------------------------------------------------
create table events (
  id                 uuid primary key default gen_random_uuid(),
  service_request_id uuid references service_requests(id) on delete cascade,
  membership_id      uuid references memberships(id) on delete cascade,
  kind               text not null,
  from_status        service_status,
  to_status          service_status,
  actor              text not null default 'system',
  payload            jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

create index events_request_idx on events (service_request_id, created_at);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['members','memberships','wigs','service_requests','shipments']
  loop
    execute format(
      'create trigger %I_touch_updated_at before update on %I
         for each row execute function touch_updated_at()', t, t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Nothing reaches these tables from a browser. The storefront talks to the
-- app proxy, the app authenticates the request against Shopify's signature,
-- and only then does the service role read or write. RLS is enabled with no
-- permissive policies so an accidentally-leaked anon key reads nothing.
-- ---------------------------------------------------------------------------
alter table members          enable row level security;
alter table memberships      enable row level security;
alter table wigs             enable row level security;
alter table service_requests enable row level security;
alter table allowance_ledger enable row level security;
alter table inspections      enable row level security;
alter table photos           enable row level security;
alter table shipments        enable row level security;
alter table events           enable row level security;
