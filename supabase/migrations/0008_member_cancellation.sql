-- Members cancelling their own membership, from the Wig Closet.
--
-- Shopify's subscriptionContractCancel ends a contract at once. That is right
-- for the money and wrong for what was already paid for: an annual member who
-- cancels in month two has bought ten more months of Rejuvenations and member
-- pricing. So the contract is cancelled straight away, and the membership is
-- held open until the date it was paid through. The rule lives in
-- spa-app/app/lib/membership-cancellation.ts; this is where the date is kept.
--
-- Null means nothing is held open — every membership until now, and any
-- cancellation made in Shopify admin, which still ends everything at once.
alter table memberships add column if not exists access_until timestamptz;

comment on column memberships.access_until is
  'After a member cancels: the date they paid through. The membership stays active until then.';

-- The daily job looks for held-open memberships whose date has passed.
create index if not exists memberships_access_until_idx
  on memberships (access_until)
  where access_until is not null and status = 'active';
