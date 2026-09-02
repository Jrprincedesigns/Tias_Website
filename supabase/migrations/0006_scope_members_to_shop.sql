-- Which store a member belongs to.
--
-- Everything in this schema hangs off members: a wig belongs to a member, a
-- membership belongs to a member, a work order belongs to a member. So scoping
-- members by shop scopes the whole database, and nothing else needs a shop
-- column to be correct.
--
-- Why it matters: the app was written against one store, and the work queue
-- asks for every open work order with no filter at all. Install it on a second
-- store — a development store, say — and Tia's live queue quietly fills with
-- test units. Nothing errors. It just shows her somebody else's studio.
--
-- The unique constraint moves with it. A Shopify customer id identifies a
-- person within a store, and the pair is what actually identifies a member.
alter table members add column if not exists shop text;

-- Everything that exists today came from the development store.
update members set shop = 'theetcollection-eczclr6r.myshopify.com' where shop is null;

alter table members alter column shop set not null;

alter table members drop constraint if exists members_shopify_customer_id_key;
create unique index if not exists members_shop_customer_idx
  on members (shop, shopify_customer_id);

create index if not exists members_shop_idx on members (shop);

comment on column members.shop is
  'The myshopify domain this member belongs to. A customer id only identifies a person within a store.';
