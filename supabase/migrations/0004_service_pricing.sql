-- What a service costs to deliver, and therefore what it should sell for.
--
-- These numbers were worked out once in a conversation and would otherwise
-- live in someone's memory. They change — a carrier raises postage, a colour
-- line gets more expensive, Tia gets faster at a service — and every one of
-- those changes should be a field she edits, not a deploy.
--
-- Money is in cents throughout. Prices computed in floating point drift by a
-- penny in ways that are maddening to reconcile against Shopify.

-- One row. The knobs that apply to every service.
create table pricing_settings (
  id                      boolean primary key default true,
  -- Tia's share of every sale. The whole model hangs off this: price is set so
  -- that her cut actually pays for the hours the work takes.
  owner_draw_percent      numeric(5,2) not null default 20,
  -- What her time is worth. Not a cost line — a target. Raising it lifts every
  -- price at once, which is the point of having it in one place.
  target_hourly_cents     integer not null default 1500,
  -- Shopify Payments on the Advanced plan.
  processing_percent      numeric(5,2) not null default 2.5,
  processing_fixed_cents  integer not null default 30,
  -- Insured round trip: USPS postage plus declared value to $1,200.
  shipping_cents          integer not null default 6800,
  updated_at              timestamptz not null default now(),
  constraint pricing_settings_single_row check (id),
  constraint owner_draw_sane check (owner_draw_percent > 0 and owner_draw_percent <= 100),
  constraint processing_sane check (processing_percent >= 0 and processing_percent < 100)
);

create table service_pricing (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique,
  -- The only per-service input that moves the price. Everything else is shared.
  hours             numeric(4,2) not null,
  materials_cents   integer not null default 800,
  -- Whether the studio is paying to get the unit here and back. On a short
  -- service this is the largest single line, so it is per-service rather than
  -- assumed.
  includes_shipping boolean not null default true,
  position          integer not null default 0,
  notes             text,
  updated_at        timestamptz not null default now(),
  constraint hours_sane check (hours > 0 and hours <= 40),
  constraint materials_sane check (materials_cents >= 0)
);

insert into pricing_settings (id) values (true) on conflict (id) do nothing;

-- The studio's current service list, with the hours Tia gave. Where she quoted
-- a range the midpoint is used, because a single number has to be chosen and
-- the midpoint is the least wrong one to start from.
insert into service_pricing (name, hours, materials_cents, includes_shipping, position, notes) values
  ('Wig Rejuvenation',   2.50,  800, true, 1, 'Wash, deep condition, restyle.'),
  ('Wig Reconstruction', 3.25,  800, true, 2, 'Tia quoted 3 to 3.5 hours.'),
  ('Wig Construction',   4.00,  800, true, 3, 'Tia quoted 3 to 5 hours, no colour.'),
  ('Color Services',     4.50, 2500, true, 4, 'Tia quoted 3 to 6 hours depending on the colour.')
on conflict (name) do nothing;

comment on table pricing_settings is 'Shared pricing inputs. One row.';
comment on table service_pricing is 'Per-service inputs. Price is derived, never stored — a stored price goes stale the moment an input changes.';
