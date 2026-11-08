-- Members asking to cancel while still inside their minimum commitment.
--
-- A monthly plan has a 3-month minimum, and until now the Wig Closet simply
-- refused a cancel before it. Members can now ask at any time: the request is
-- written down here, their remaining minimum payments still go through, and
-- the daily job cancels the contract once the last of them has been paid
-- (spa-app/app/lib/membership-cancellation.ts). From then on it is the same
-- as any other member cancel — held open to the paid-through date
-- (access_until, 0008).
--
-- A member can withdraw the request until the job carries it out; both
-- columns go back to null.
alter table memberships add column if not exists cancel_requested_at timestamptz;
alter table memberships add column if not exists cancel_ends_on timestamptz;

comment on column memberships.cancel_requested_at is
  'When the member asked to cancel during their minimum term. Carried out by the daily job once the minimum is paid.';
comment on column memberships.cancel_ends_on is
  'The date a requested cancellation was promised to end the membership: the end of the minimum term.';

-- The daily job looks for requests it has not yet carried out.
create index if not exists memberships_cancel_requested_idx
  on memberships (cancel_requested_at)
  where cancel_requested_at is not null and cancelled_at is null and status = 'active';
