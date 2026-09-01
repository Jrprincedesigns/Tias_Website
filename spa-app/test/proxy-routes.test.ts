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
let whoamiLoader: any;
let wigsAction: any;

before(async () => {
  if (!CONNECTION) return;
  pool = new pg.Pool({ connectionString: CONNECTION, max: 4 });
  ({ loader: closetLoader } = await import('../app/routes/closet.ts'));
  ({ action: serviceRequestAction } = await import('../app/routes/service-request.ts'));
  ({ loader: whoamiLoader } = await import('../app/routes/whoami.ts'));
  ({ action: wigsAction } = await import('../app/routes/wigs.ts'));
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
  const request = new Request(signedUrl('/closet', {
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
  const request = new Request(signedUrl('/closet', { shop: 's', logged_in_customer_id: '7401' }));
  const response = await closetLoader({ request, params: {}, context: {} });
  assert.match(response.headers.get('cache-control') ?? '', /private/);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
});

test('a forged signature is rejected', { skip }, async () => {
  const request = new Request(
    'https://app.example.com/proxy/closet?shop=s&logged_in_customer_id=7401&signature=deadbeef',
  );
  const response = await closetLoader({ request, params: {}, context: {} });
  // Always 200 at the transport layer: Shopify's proxy discards the body of a
  // non-2xx response and shows its own error page instead.
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'invalid_signature');
  assert.equal(body.httpStatus, 401);
});

test('changing the customer id invalidates the signature', { skip }, async () => {
  await seed();
  const url = new URL(signedUrl('/closet', { shop: 's', logged_in_customer_id: '7401' }));
  url.searchParams.set('logged_in_customer_id', '9999'); // impersonation attempt
  const response = await closetLoader({ request: new Request(url), params: {}, context: {} });
  assert.equal((await response.json()).error, 'invalid_signature');
});

test('a signed but logged-out visitor gets a normal answer, not an error', { skip }, async () => {
  const request = new Request(signedUrl('/closet', { shop: 's', timestamp: '1700000000' }));
  const response = await closetLoader({ request, params: {}, context: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, signedIn: false });
});

test('a member with no membership still gets their wigs', { skip }, async () => {
  await pool.query(`insert into members (shopify_customer_id) values ('gid://shopify/Customer/7401')`);
  const request = new Request(signedUrl('/closet', { shop: 's', logged_in_customer_id: '7401' }));
  const body = await (await closetLoader({ request, params: {}, context: {} })).json();
  assert.equal(body.signedIn, true);
  assert.equal(body.membership, null);
  assert.deepEqual(body.wigs, []);
});

test('a service request against your own wig is created and marked covered', { skip }, async () => {
  const seeded = await seed();
  const request = new Request(
    signedUrl('/service-request', { shop: 's', logged_in_customer_id: '7401' }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wigId: seeded.wigId, serviceType: 'rejuvenation', notes: 'lace lifting' }),
    },
  );
  const response = await serviceRequestAction({ request, params: {}, context: {} });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.httpStatus, 201);
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
    signedUrl('/service-request', { shop: 's', logged_in_customer_id: '7401' }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wigId: otherWig.rows[0].id, serviceType: 'rejuvenation' }),
    },
  );
  const response = await serviceRequestAction({ request, params: {}, context: {} });
  const refused = await response.json();
  assert.equal(refused.error, 'unknown_wig', 'must not leak that the wig exists');
  assert.equal(refused.httpStatus, 404);

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
    signedUrl('/service-request', { shop: 's', logged_in_customer_id: '7401' }),
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
    signedUrl('/service-request', { shop: 's', logged_in_customer_id: '7401' }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wigId: 'nope', serviceType: 'teleportation' }),
    },
  );
  const response = await serviceRequestAction({ request, params: {}, context: {} });
  const invalid = await response.json();
  assert.equal(invalid.httpStatus, 422);
  assert.equal(invalid.details.length, 2);
});

test('whoami confirms a signed-in visitor without touching the database', { skip }, async () => {
  // Deliberately no seeding — whoami must isolate the Shopify half of the
  // chain from the Supabase half, so a database problem cannot masquerade as
  // an identity problem.
  const request = new Request(signedUrl('/whoami', {
    shop: 'theetcollection.myshopify.com',
    logged_in_customer_id: '7401',
  }));
  const response = await whoamiLoader({ request, params: {}, context: {} });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.signatureValid, true);
  assert.equal(body.signedIn, true);
  assert.equal(body.shopifyCustomerId, 'gid://shopify/Customer/7401');
  assert.equal(body.shop, 'theetcollection.myshopify.com');
});

test('whoami reports an anonymous visitor as signed out, not as an error', { skip }, async () => {
  const request = new Request(signedUrl('/whoami', { shop: 's' }));
  const response = await whoamiLoader({ request, params: {}, context: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, signedIn: false });
});

test('whoami rejects a forged signature', { skip }, async () => {
  const request = new Request('https://app.example.com/whoami?shop=s&logged_in_customer_id=1&signature=bad');
  const response = await whoamiLoader({ request, params: {}, context: {} });
  assert.equal((await response.json()).error, 'invalid_signature');
});

test('a missing app secret answers with a named error, not an opaque 500', { skip }, async () => {
  // Shopify renders "There was an error in the third-party application" for an
  // uncaught throw, which tells a debugger nothing. This must name itself.
  const saved = process.env.SHOPIFY_API_SECRET;
  const savedDebug = process.env.WIG_SPA_DEBUG_ERRORS;
  delete process.env.SHOPIFY_API_SECRET;
  process.env.WIG_SPA_DEBUG_ERRORS = 'true';
  try {
    const request = new Request('https://app.example.com/whoami?shop=s&signature=whatever');
    const response = await whoamiLoader({ request, params: {}, context: {} });
    assert.equal(response.status, 200, 'the transport must succeed so the body survives');

    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'app_misconfigured');
    assert.equal(body.httpStatus, 500);
    assert.match(body.detail, /SHOPIFY_API_SECRET/);
  } finally {
    if (saved) process.env.SHOPIFY_API_SECRET = saved;
    if (savedDebug === undefined) delete process.env.WIG_SPA_DEBUG_ERRORS;
    else process.env.WIG_SPA_DEBUG_ERRORS = savedDebug;
  }
});

test('error detail is withheld unless debugging is switched on', { skip }, async () => {
  const saved = process.env.SHOPIFY_API_SECRET;
  const savedDebug = process.env.WIG_SPA_DEBUG_ERRORS;
  const savedNodeEnv = process.env.NODE_ENV;
  delete process.env.SHOPIFY_API_SECRET;
  delete process.env.WIG_SPA_DEBUG_ERRORS;
  process.env.NODE_ENV = 'production';
  try {
    const request = new Request('https://app.example.com/whoami?shop=s&signature=whatever');
    const response = await whoamiLoader({ request, params: {}, context: {} });
    const body = await response.json();
    assert.equal(body.error, 'app_misconfigured');
    assert.equal(body.detail, undefined, 'internals are not handed to storefront visitors');
  } finally {
    if (saved) process.env.SHOPIFY_API_SECRET = saved;
    if (savedDebug !== undefined) process.env.WIG_SPA_DEBUG_ERRORS = savedDebug;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  }
});

test('every proxy response is HTTP 200, whatever went wrong', { skip }, async () => {
  // The rule this file exists to protect: Shopify's app proxy discards the
  // body of any non-2xx response and substitutes its own error page. A status
  // code is therefore the one place an error message cannot live.
  const seeded = await seed();

  const cases: Array<[string, Promise<Response>]> = [
    ['forged signature', whoamiLoader({
      request: new Request('https://app.example.com/whoami?shop=s&signature=bad'),
      params: {}, context: {},
    })],
    ['anonymous visitor', closetLoader({
      request: new Request(signedUrl('/closet', { shop: 's' })), params: {}, context: {},
    })],
    ['signed-in member', closetLoader({
      request: new Request(signedUrl('/closet', { shop: 's', logged_in_customer_id: '7401' })),
      params: {}, context: {},
    })],
    ["someone else's wig", serviceRequestAction({
      request: new Request(signedUrl('/service-request', { shop: 's', logged_in_customer_id: '7401' }), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wigId: '00000000-0000-0000-0000-000000000000', serviceType: 'repair' }),
      }),
      params: {}, context: {},
    })],
    ['malformed intake', serviceRequestAction({
      request: new Request(signedUrl('/service-request', { shop: 's', logged_in_customer_id: '7401' }), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wigId: 'nope', serviceType: 'nope' }),
      }),
      params: {}, context: {},
    })],
    ['valid intake', serviceRequestAction({
      request: new Request(signedUrl('/service-request', { shop: 's', logged_in_customer_id: '7401' }), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wigId: seeded.wigId, serviceType: 'rejuvenation' }),
      }),
      params: {}, context: {},
    })],
  ];

  for (const [label, pending] of cases) {
    const response = await pending;
    assert.equal(response.status, 200, `${label} must answer 200 so its body survives Shopify`);
    const body = await response.json();
    assert.equal(typeof body.ok, 'boolean', `${label} must say whether it succeeded`);
  }
});

test('a member registers a unit through the proxy', { skip }, async () => {
  const request = new Request(
    signedUrl('/wigs', { shop: 's', logged_in_customer_id: '7401' }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: 'Jet Black Straight', lengthInches: 24, texture: 'straight' }),
    },
  );
  const response = await wigsAction({ request, params: {}, context: {} });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.wig.nickname, 'Jet Black Straight');
  assert.equal(body.wig.lengthInches, 24);
  assert.equal(body.httpStatus, 201);
});

test('registering a unit with no name explains itself', { skip }, async () => {
  const request = new Request(
    signedUrl('/wigs', { shop: 's', logged_in_customer_id: '7401' }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texture: 'body wave' }),
    },
  );
  const body = await (await wigsAction({ request, params: {}, context: {} })).json();
  assert.equal(body.ok, false);
  assert.equal(body.httpStatus, 422);
  assert.match(body.details[0], /name/i);
});

test('an anonymous visitor cannot register a unit', { skip }, async () => {
  const request = new Request(
    signedUrl('/wigs', { shop: 's' }),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"nickname":"x"}' },
  );
  const body = await (await wigsAction({ request, params: {}, context: {} })).json();
  assert.equal(body.signedIn, false);

  const { rows } = await pool.query(`select count(*)::int as n from wigs where nickname = 'x'`);
  assert.equal(rows[0].n, 0, 'nothing was written');
});

test('a service request attaches only the photos that belong to the member', { skip }, async () => {
  const seeded = await seed();
  const memberRow = await pool.query(
    `select id from members where shopify_customer_id = 'gid://shopify/Customer/7401'`,
  );
  const memberId = memberRow.rows[0].id;

  const request = new Request(
    signedUrl('/service-request', { shop: 's', logged_in_customer_id: '7401' }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wigId: seeded.wigId,
        serviceType: 'rejuvenation',
        photoPaths: [`${memberId}/intake/one.jpg`, `${memberId}/intake/two.jpg`],
      }),
    },
  );
  const body = await (await serviceRequestAction({ request, params: {}, context: {} })).json();
  assert.equal(body.ok, true);
  assert.equal(body.photosAttached, 2);
});

test('a forged photo path loses the photos but never the wig', { skip }, async () => {
  // A unit already on its way to the studio must not be lost because a path was
  // wrong. The request saves; the photos do not.
  const seeded = await seed();
  const request = new Request(
    signedUrl('/service-request', { shop: 's', logged_in_customer_id: '7401' }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wigId: seeded.wigId,
        serviceType: 'rejuvenation',
        photoPaths: ['some-other-member/intake/theirs.jpg'],
      }),
    },
  );
  const body = await (await serviceRequestAction({ request, params: {}, context: {} })).json();
  assert.equal(body.ok, true, 'the service request still exists');
  assert.equal(body.photosAttached, 0, 'but the foreign photo was refused');

  const { rows } = await pool.query(`select count(*)::int as n from photos`);
  assert.equal(rows[0].n, 0);
});
