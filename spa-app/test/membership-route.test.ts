import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

/**
 * Self-serve cancellation, end to end: real signatures, a real database, and
 * a stand-in for the Admin API that records what it was asked to do. What
 * matters most here is what does NOT reach Shopify — a cancel under the
 * minimum, or against someone else's contract.
 */
const CONNECTION = process.env.TEST_DATABASE_URL;
const skip = CONNECTION ? false : 'TEST_DATABASE_URL not set';

const SECRET = 'test_app_secret';
process.env.SHOPIFY_API_SECRET = SECRET;
if (CONNECTION) process.env.DATABASE_URL = CONNECTION;

const SHOP = 'theetcollection.myshopify.com';
const CUSTOMER = 'gid://shopify/Customer/7401';
const CONTRACT = 'gid://shopify/SubscriptionContract/9001';

let pool: pg.Pool;
let membershipLoader: any;
let membershipAction: any;
let db: typeof import('../app/lib/db.ts');
let cancellation: typeof import('../app/lib/membership-cancellation.ts');

/** What the fake Admin API answers, and what it was asked. */
interface FakeShopify {
  contract: Record<string, unknown> | null;
  cancelError?: string;
  tagError?: string;
  calls: Array<{ op: string; variables: any }>;
}
let shopify: FakeShopify;

function fakeAdmin() {
  return {
    graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
      const variables = options?.variables ?? {};
      const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? 'unknown';
      shopify.calls.push({ op, variables });
      let data: unknown;
      if (op === 'MemberContract') data = { subscriptionContract: shopify.contract };
      else if (op === 'CancelMemberContract') {
        if (shopify.cancelError) return Response.json({ errors: [{ message: shopify.cancelError }] });
        data = { subscriptionContractCancel: { contract: { id: variables.id, status: 'CANCELLED' }, userErrors: [] } };
      } else if (op === 'RemoveMemberTags') {
        if (shopify.tagError) return Response.json({ errors: [{ message: shopify.tagError }] });
        data = { tagsRemove: { userErrors: [] } };
      } else if (op === 'AddMemberTags') data = { tagsAdd: { userErrors: [] } };
      return Response.json({ data });
    },
  };
}

/** A contract as Shopify returns it, monthly by default. */
function shopifyContract(overrides: { renewals?: number; [key: string]: unknown } = {}) {
  const { renewals = 0, ...rest } = overrides;
  return {
    id: CONTRACT,
    status: 'ACTIVE',
    createdAt: '2026-09-15T12:00:00Z',
    nextBillingDate: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    customer: { id: CUSTOMER },
    billingPolicy: { interval: 'MONTH', intervalCount: 1, minCycles: 3 },
    lines: { nodes: [{ title: 'The Wig Spa Membership', variantTitle: 'Essential Care', sellingPlanName: 'Monthly (3-month minimum)' }] },
    billingAttempts: { nodes: Array.from({ length: renewals }, () => ({ ready: true, errorCode: null })) },
    ...rest,
  };
}

before(async () => {
  if (!CONNECTION) return;
  pool = new pg.Pool({ connectionString: CONNECTION, max: 4 });
  ({ loader: membershipLoader, action: membershipAction } = await import('../app/routes/membership.ts'));
  const { shopAdmin } = await import('../app/shop-admin.server.ts');
  shopAdmin.forShop = async () => fakeAdmin();
  db = await import('../app/lib/db.ts');
  cancellation = await import('../app/lib/membership-cancellation.ts');
});

after(async () => {
  if (!CONNECTION) return;
  if (pool) await pool.end();
  const { default: appPool } = await import('../app/db.server.ts');
  await appPool.end();
});

beforeEach(async () => {
  if (!CONNECTION) return;
  shopify = { contract: shopifyContract(), calls: [] };
  await pool.query('truncate members, memberships, wigs, service_requests, allowance_ledger, events cascade');
});

function signedRequest(params: Record<string, string>, init?: RequestInit): Request {
  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('');
  const signature = crypto.createHmac('sha256', SECRET).update(message, 'utf8').digest('hex');
  const search = new URLSearchParams(params);
  search.set('signature', signature);
  return new Request(`https://app.example.com/membership?${search}`, init);
}

const asMember = (init?: RequestInit) => signedRequest({ shop: SHOP, logged_in_customer_id: '7401' }, init);
const post = () => asMember({ method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });

async function seedMembership(customer = CUSTOMER, contractId = CONTRACT) {
  const member = await pool.query(
    `insert into members (shop, shopify_customer_id) values ($1, $2) returning id`,
    [SHOP, customer],
  );
  const membership = await pool.query(
    `insert into memberships (member_id, shopify_contract_id, tier, status, membership_year_start, membership_year_end)
     values ($1, $2, 'Essential Care', 'active', current_date, current_date + interval '1 year') returning id`,
    [member.rows[0].id, contractId],
  );
  return membership.rows[0].id as string;
}

const cancels = () => shopify.calls.filter((call) => call.op === 'CancelMemberContract');

test('a monthly member under the minimum sees their plan and the date they can cancel', { skip }, async () => {
  await seedMembership();
  const body = await (await membershipLoader({ request: asMember(), params: {}, context: {} })).json();
  assert.equal(body.ok, true);
  assert.equal(body.membership.planName, 'Monthly (3-month minimum)');
  assert.equal(body.membership.paidCycles, 1);
  assert.equal(body.membership.canCancel, false);
  assert.equal(body.membership.reason, 'minimum_term');
  assert.equal(body.membership.cancellableFrom, '2026-11-15T12:00:00.000Z');
  assert.ok(body.membership.nextBillingDate);
});

test('a cancel under the minimum is refused and never reaches Shopify', { skip }, async () => {
  const membershipId = await seedMembership();
  shopify.contract = shopifyContract({ renewals: 1 });

  const response = await membershipAction({ request: post(), params: {}, context: {} });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'cannot_cancel');
  assert.equal(body.membership.reason, 'minimum_term');
  assert.equal(cancels().length, 0);

  const row = await pool.query(`select cancelled_at, access_until from memberships where id = $1`, [membershipId]);
  assert.equal(row.rows[0].cancelled_at, null);
});

test('after three payments the member cancels, and keeps their benefits to the paid-through date', { skip }, async () => {
  const membershipId = await seedMembership();
  shopify.contract = shopifyContract({ renewals: 2 });
  const paidThrough = shopify.contract.nextBillingDate as string;

  const body = await (await membershipAction({ request: post(), params: {}, context: {} })).json();
  assert.equal(body.ok, true);
  assert.equal(body.membership.cancelled, true);
  assert.equal(body.membership.endsOn, new Date(paidThrough).toISOString());

  assert.deepEqual(cancels().map((call) => call.variables.id), [CONTRACT]);

  const row = await pool.query(
    `select status, cancelled_at, access_until from memberships where id = $1`,
    [membershipId],
  );
  assert.equal(row.rows[0].status, 'active');
  assert.ok(row.rows[0].cancelled_at);
  assert.equal(new Date(row.rows[0].access_until).toISOString(), new Date(paidThrough).toISOString());
});

test('an annual member can cancel straight away', { skip }, async () => {
  await seedMembership();
  shopify.contract = shopifyContract({
    billingPolicy: { interval: 'YEAR', intervalCount: 1, minCycles: 1 },
    lines: { nodes: [{ title: 'The Wig Spa Membership', variantTitle: 'Essential Care', sellingPlanName: 'Annual' }] },
  });
  const body = await (await membershipAction({ request: post(), params: {}, context: {} })).json();
  assert.equal(body.ok, true);
  assert.equal(cancels().length, 1);
});

test('the webhook that follows a member cancel keeps the membership open', { skip }, async () => {
  const membershipId = await seedMembership();
  shopify.contract = shopifyContract({ renewals: 2 });
  await membershipAction({ request: post(), params: {}, context: {} });

  const result = await db.upsertMembershipFromContract(pool, {
    shop: SHOP,
    shopifyContractId: CONTRACT,
    shopifyCustomerId: CUSTOMER,
    status: 'CANCELLED',
    tier: 'Essential Care',
    discountPercent: 10,
    rejuvenationsPerPeriod: 1,
    nextBillingAt: null,
  });
  assert.equal(result.status, 'active');
  const row = await pool.query(`select status, cancelled_at from memberships where id = $1`, [membershipId]);
  assert.equal(row.rows[0].status, 'active');
  assert.ok(row.rows[0].cancelled_at);
});

test('a cancel made in Shopify admin still ends the membership at once', { skip }, async () => {
  const membershipId = await seedMembership();
  const result = await db.upsertMembershipFromContract(pool, {
    shop: SHOP,
    shopifyContractId: CONTRACT,
    shopifyCustomerId: CUSTOMER,
    status: 'CANCELLED',
    tier: 'Essential Care',
    discountPercent: 10,
    rejuvenationsPerPeriod: 1,
    nextBillingAt: null,
  });
  assert.equal(result.status, 'cancelled');
  const row = await pool.query(`select status from memberships where id = $1`, [membershipId]);
  assert.equal(row.rows[0].status, 'cancelled');
});

test('a contract Shopify says belongs to someone else is never cancelled', { skip }, async () => {
  await seedMembership();
  shopify.contract = shopifyContract({ renewals: 5, customer: { id: 'gid://shopify/Customer/1' } });

  const loaded = await (await membershipLoader({ request: asMember(), params: {}, context: {} })).json();
  assert.equal(loaded.membership, null);

  const body = await (await membershipAction({ request: post(), params: {}, context: {} })).json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'no_membership');
  assert.equal(cancels().length, 0);
});

test("another member's membership is not reachable from your session", { skip }, async () => {
  await seedMembership('gid://shopify/Customer/5555');
  const body = await (await membershipAction({ request: post(), params: {}, context: {} })).json();
  assert.equal(body.error, 'no_membership');
  assert.equal(shopify.calls.length, 0);
});

test('a failed Shopify cancel leaves the membership as it was', { skip }, async () => {
  const membershipId = await seedMembership();
  shopify.contract = shopifyContract({ renewals: 2 });
  shopify.cancelError = 'Internal error';

  const response = await membershipAction({ request: post(), params: {}, context: {} });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'server_error');

  const row = await pool.query(`select cancelled_at, access_until from memberships where id = $1`, [membershipId]);
  assert.equal(row.rows[0].cancelled_at, null);
  assert.equal(row.rows[0].access_until, null);
});

test('cancelling twice is answered, not repeated', { skip }, async () => {
  await seedMembership();
  shopify.contract = shopifyContract({ renewals: 2 });
  await membershipAction({ request: post(), params: {}, context: {} });

  shopify.contract = shopifyContract({ renewals: 2, status: 'CANCELLED' });
  const again = await (await membershipAction({ request: post(), params: {}, context: {} })).json();
  assert.equal(again.ok, true);
  assert.equal(again.membership.cancelled, true);
  assert.equal(cancels().length, 1);

  const loaded = await (await membershipLoader({ request: asMember(), params: {}, context: {} })).json();
  assert.equal(loaded.membership.reason, 'already_cancelled');
  assert.equal(loaded.membership.canCancel, false);
});

test('an anonymous visitor gets a normal signed-out answer', { skip }, async () => {
  const request = signedRequest({ shop: SHOP });
  assert.deepEqual(await (await membershipLoader({ request, params: {}, context: {} })).json(), {
    ok: true,
    signedIn: false,
  });
  assert.equal(shopify.calls.length, 0);
});

test('a GET to the cancel endpoint cancels nothing', { skip }, async () => {
  await seedMembership();
  shopify.contract = shopifyContract({ renewals: 2 });
  const body = await (await membershipAction({ request: asMember(), params: {}, context: {} })).json();
  assert.equal(body.error, 'method_not_allowed');
  assert.equal(cancels().length, 0);
});

test('the daily job ends memberships past their paid-through date, and only those', { skip }, async () => {
  const lapsed = await seedMembership();
  const current = await seedMembership('gid://shopify/Customer/5555', 'gid://shopify/SubscriptionContract/2');
  await pool.query(
    `update memberships set cancelled_at = now() - interval '40 days', access_until = now() - interval '1 day' where id = $1`,
    [lapsed],
  );
  await pool.query(
    `update memberships set cancelled_at = now(), access_until = now() + interval '30 days' where id = $1`,
    [current],
  );

  const result = await cancellation.endLapsedMemberships(pool, async () => fakeAdmin());
  assert.deepEqual(result.closed, [lapsed]);
  assert.deepEqual(result.failed, []);
  const removed = shopify.calls.filter((call) => call.op === 'RemoveMemberTags');
  assert.deepEqual(removed.map((call) => call.variables.id), [CUSTOMER]);

  const rows = await pool.query(`select id, status from memberships`);
  const status = Object.fromEntries(rows.rows.map((row) => [row.id, row.status]));
  assert.equal(status[lapsed], 'cancelled');
  assert.equal(status[current], 'active');

  // A second run has nothing to do.
  const again = await cancellation.endLapsedMemberships(pool, async () => fakeAdmin());
  assert.deepEqual(again.closed, []);
});

test('the daily job leaves a membership open when its tags cannot be removed', { skip }, async () => {
  const lapsed = await seedMembership();
  await pool.query(
    `update memberships set cancelled_at = now(), access_until = now() - interval '1 day' where id = $1`,
    [lapsed],
  );
  shopify.tagError = 'Throttled';

  const result = await cancellation.endLapsedMemberships(pool, async () => fakeAdmin());
  assert.deepEqual(result.closed, []);
  assert.equal(result.failed.length, 1);
  const row = await pool.query(`select status from memberships where id = $1`, [lapsed]);
  // Retried tomorrow, rather than closed here with member pricing still on.
  assert.equal(row.rows[0].status, 'active');
});

test('the closet says when a cancelled membership ends, instead of a renewal', { skip }, async () => {
  const { loader: closetLoader } = await import('../app/routes/closet.ts');
  const membershipId = await seedMembership();

  let body = await (await closetLoader({ request: asMember(), params: {}, context: {} } as any)).json();
  assert.equal(body.membership.endsOn, null);

  await pool.query(
    `update memberships set cancelled_at = now(), access_until = '2026-12-15T12:00:00Z' where id = $1`,
    [membershipId],
  );
  body = await (await closetLoader({ request: asMember(), params: {}, context: {} } as any)).json();
  assert.equal(body.membership.status, 'active');
  assert.equal(body.membership.endsOn, '2026-12-15T12:00:00.000Z');
});
