import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

/**
 * Exercises the proxy endpoints the way Shopify calls them: real signatures,
 * a real database behind them. The route modules import ../db.server, which
 * reads DATABASE_URL, so that is pointed at the test database here.
 */
const CONNECTION = process.env.TEST_DATABASE_URL;
const skip = CONNECTION ? false : 'TEST_DATABASE_URL not set';

const SECRET = 'test_app_secret';
process.env.SHOPIFY_API_SECRET = SECRET;
if (CONNECTION) process.env.DATABASE_URL = CONNECTION;

let pool: pg.Pool;
let closetLoader: any;
let serviceRequestAction: any;

before(async () => {
  if (!CONNECTION) return;
  pool = new pg.Pool({ connectionString: CONNECTION, max: 4 });
  ({ loader: closetLoader } = await import('../app/routes/proxy.closet.ts'));
  ({ action: serviceRequestAction } = await import('../app/routes/proxy.service-request.ts'));
});

after(async () => {
  if (!CONNECTION) return;
  if (pool) await pool.end();
  // The routes hold their own pool; leave it open and the test process hangs.
  const { default: appPool } = await import('../app/db.server.ts');
  await appPool.end();
});

beforeEach(async () => {
  if (!CONNECTION) return;
  await pool.query('truncate members, memberships, wigs, service_requests, allowance_ledger, events cascade');
});

/** Build a URL signed the way Shopify signs proxy requests. */
function signedUrl(path: string, params: Record<string, string>): string {
  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('');
  const signature = crypto.createHmac('sha256', SECRET).update(message, 'utf8').digest('hex');
  const search = new URLSearchParams(params);
  search.set('signature', signature);
  return `https://app.example.com${path}?${search}`;
}

async function seed() {
  const member = await pool.query(
    `insert into members (shopify_customer_id, email) values ('gid://shopify/Customer/7401', 'm@example.com') returning id`,
  );
  const memberId = member.rows[0].id;
  const membership = await pool.query(
    `insert into memberships (member_id, tier, status, membership_year_start, membership_year_end)
     values ($1, 'founding', 'active', current_date, current_date + interval '1 year') returning id`,
    [memberId],
  );
  await pool.query(
    `insert into allowance_ledger (membership_id, kind, delta, reason) values ($1, 'grant', 2, 'seed')`,
    [membership.rows[0].id],
  );
  const wig = await pool.query(
    `insert into wigs (member_id, nickname, length_inches) values ($1, 'Chocolate Body Wave', 26) returning id`,
    [memberId],
  );
  return { memberId, membershipId: membership.rows[0].id, wigId: wig.rows[0].id };
}

test('a signed request from a member returns their closet', { skip }, async () => {
  const seeded = await seed();
  const request = new Request(signedUrl('/proxy/closet', {
    shop: 'theetcollection.myshopify.com',
    logged_in_customer_id: '7401',
    timestamp: '1700000000',
  }));

  const response = await closetLoader({ request, params: {}, context: {} });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.signedIn, true);
  assert.equal(body.membership.tier, 'founding');
  assert.equal(body.membership.servicesRemaining, 2);
  assert.equal(body.wigs.length, 1);
  assert.equal(body.wigs[0].id, seeded.wigId);
});

test('closet responses are never cached', { skip }, async () => {
  await seed();
  const request = new Request(signedUrl('/proxy/closet', { shop: 's', logged_in_customer_id: '7401' }));
  const response = await closetLoader({ request, params: {}, context: {} });
  assert.match(response.headers.get('cache-control') ?? '', /private/);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
});

test('a forged signature is rejected', { skip }, async () => {
  const request = new Request(
    'https://app.example.com/proxy/closet?shop=s&logged_in_customer_id=7401&signature=deadbeef',
  );
  const response = await closetLoader({ request, params: {}, context: {} });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'invalid_signature');
});

test('changing the customer id invalidates the signature', { skip }, async () => {
  await seed();
  const url = new URL(signedUrl('/proxy/closet', { shop: 's', logged_in_customer_id: '7401' }));
  url.searchParams.set('logged_in_customer_id', '9999'); // impersonation attempt
  const response = await closetLoader({ request: new Request(url), params: {}, context: {} });
  assert.equal(response.status, 401);
});

test('a signed but logged-out visitor gets a normal answer, not an error', { skip }, async () => {
  const request = new Request(signedUrl('/proxy/closet', { shop: 's', timestamp: '1700000000' }));
  const response = await closetLoader({ request, params: {}, context: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { signedIn: false });
});

test('a member with no membership still gets their wigs', { skip }, async () => {
  await pool.query(`insert into members (shopify_customer_id) values ('gid://shopify/Customer/7401')`);
  const request = new Request(signedUrl('/proxy/closet', { shop: 's', logged_in_customer_id: '7401' }));
  const body = await (await closetLoader({ request, params: {}, context: {} })).json();
  assert.equal(body.signedIn, true);
  assert.equal(body.membership, null);
  assert.deepEqual(body.wigs, []);
});

test('a service request against your own wig is created and marked covered', { skip }, async () => {
  const seeded = await seed();
  const request = new Request(
    signedUrl('/proxy/service-request', { shop: 's', logged_in_customer_id: '7401' }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wigId: seeded.wigId, serviceType: 'rejuvenation', notes: 'lace lifting' }),
    },
  );
  const response = await serviceRequestAction({ request, params: {}, context: {} });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.coveredByAllowance, true);
  assert.equal(body.status, 'requested');
});

test("a service request against someone else's wig is refused", { skip }, async () => {
  await seed();
  // A second member with their own wig.
  const other = await pool.query(
    `insert into members (shopify_customer_id) values ('gid://shopify/Customer/9999') returning id`,
  );
  const otherWig = await pool.query(
    `insert into wigs (member_id, nickname) values ($1, 'Not Yours') returning id`,
    [other.rows[0].id],
  );

  const request = new Request(
    signedUrl('/proxy/service-request', { shop: 's', logged_in_customer_id: '7401' }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wigId: otherWig.rows[0].id, serviceType: 'rejuvenation' }),
    },
  );
  const response = await serviceRequestAction({ request, params: {}, context: {} });
  assert.equal(response.status, 404, 'must not leak that the wig exists');

  const created = await pool.query('select count(*)::int as n from service_requests');
  assert.equal(created.rows[0].n, 0, 'nothing was written');
});

test('a member out of services gets a reason, not a silent charge', { skip }, async () => {
  const seeded = await seed();
  // Spend both granted services on unrelated requests.
  await pool.query(
    `insert into allowance_ledger (membership_id, kind, delta, reason) values ($1, 'adjustment', -2, 'used up')`,
    [seeded.membershipId],
  );

  const request = new Request(
    signedUrl('/proxy/service-request', { shop: 's', logged_in_customer_id: '7401' }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wigId: seeded.wigId, serviceType: 'rejuvenation' }),
    },
  );
  const body = await (await serviceRequestAction({ request, params: {}, context: {} })).json();
  assert.equal(body.coveredByAllowance, false);
  assert.equal(body.coverageReason, 'no_services_left');
});

test('a malformed body is refused with the reasons why', { skip }, async () => {
  await seed();
  const request = new Request(
    signedUrl('/proxy/service-request', { shop: 's', logged_in_customer_id: '7401' }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wigId: 'nope', serviceType: 'teleportation' }),
    },
  );
  const response = await serviceRequestAction({ request, params: {}, context: {} });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).details.length, 2);
});
