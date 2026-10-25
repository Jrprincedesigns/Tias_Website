-- Included Rejuvenations, granted every three months.
--
-- Membership includes services again: Rejuvenations, a fixed number per
-- three-month period depending on the tier and term. Unused ones roll into the
-- next period, but each period's grant expires 30 days after that period ends.
-- The rules live in spa-app/app/lib/allowance.ts; this is what they need to be
-- written down.

-- Stored per membership, like discount_percent: a member keeps the allowance
-- they bought even if the tier changes later. Null means none — including every
-- membership sold before Rejuvenations were included.
alter table memberships add column if not exists rejuvenations_per_period integer;

comment on column memberships.rejuvenations_per_period is
  'Rejuvenations granted each three-month period, at the time of joining. Null or 0 means none.';

alter table allowance_ledger
  add column if not exists period_start     date,
  add column if not exists expires_at       timestamptz,
  add column if not exists expires_entry_id uuid references allowance_ledger(id) on delete cascade;

-- Grants are written lazily, whenever a balance is read, so two readers can
-- race to write the same period. One grant per period per membership.
create unique index if not exists allowance_one_grant_per_period
  on allowance_ledger (membership_id, period_start)
  where kind = 'grant' and period_start is not null;

-- And one expiry per grant, for the same reason.
create unique index if not exists allowance_one_expiry_per_grant
  on allowance_ledger (expires_entry_id)
  where kind = 'expiry' and expires_entry_id is not null;
