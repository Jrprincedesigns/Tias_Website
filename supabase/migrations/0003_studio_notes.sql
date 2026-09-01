-- Notes the studio writes *for the member*.
--
-- `staff_notes` already exists and stays what it is: internal working notes,
-- surfaced only in Tia's work-order screen. Pointing the member-facing panel at
-- that column would have retroactively published every internal note ever
-- written, so the customer-facing note is its own column. Tia writes here
-- knowing the member reads it.
--
-- Nullable with no default: an absent note is the normal case, and the panel
-- renders nothing rather than an empty section.
alter table service_requests add column if not exists studio_notes text;

comment on column service_requests.staff_notes is
  'Internal working notes. Never shown to the member.';
comment on column service_requests.studio_notes is
  'Notes written for the member. Rendered in the Wig Closet detail panel.';
