-- What a membership is actually worth to the member holding it.
--
-- Membership used to include a set number of services, and the closet counted
-- them down from the allowance ledger. It no longer includes any: it is member
-- pricing and a place in the queue. So the number worth showing a member is the
-- discount they are getting, and until now nothing in this database recorded
-- it — it lived only in Shopify, as a metafield on the variant they bought.
--
-- Stored per membership rather than looked up from the tier, because a member
-- keeps the terms they bought. If the Signature discount changes next year,
-- everyone who joined this year keeps fifteen percent, and this column is the
-- only place that remembers.
alter table memberships add column if not exists discount_percent integer;

comment on column memberships.discount_percent is
  'Member discount at the time of joining. Not derived from the tier — a member keeps the terms they bought.';
