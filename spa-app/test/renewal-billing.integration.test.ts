import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

/**
 * Renewal billing end to end: a real database, the real claim-before-charge
 * rule, and a stand-in for the Admin API that records every charge it is asked
 * for. No request here can reach Shopify — every Admin call goes to the fake.
 *
 * What matters most is how many times a cycle is charged: once when it is due,
 * never when it is not, and never twice however the job is run.
 */
const CONNECTION = process.env.TEST_DATABASE_URL;
const skip = CONNECTION ? false : 'TEST_DATABASE_URL not set';

if (CONNECTION) process.env.DATABASE_URL = CONNECTION;
// Alerts only log while this is unset; nothing is posted anywhere.
delete process.env.ALERT_WEBHOOK_URL;

const SHOP = 'theetcollection-eczclr6r.myshopify.com';
const CUSTOMER = 'gid://shopify/Customer/7401';
const CONTRACT = 'gid://shopify/SubscriptionContract/9001';
const DAY = 86_400_000;

const CREATED = new Date('2026-10-25T15:00:00Z');
const FIRST_RENEWAL = new Date('2026-11-25T15:00:00Z');

let pool: pg.Pool;
let billing: typeof import('../app/lib/renewal-billing.ts');
let cronLoader: any;

interface FakeCycle {
  cycleIndex: number;
  billingAttemptExpectedDate: string;
  status: 'BILLED' | 'UNBILLED';
  skipped: boolean;
}

/** What the fake Admin API answers, and what it was asked. */
interface FakeShopify {
  contract: { id: string; status: string; createdAt: string; nextBillingDate: string; billingPolicy: any };
  cycles: FakeCycle[];
  chargeUserErrors?: Array<{ field: string[]; message: string; code: string }>;
  chargeThrows?: boolean;
  calls: Array<{ op: string; variables: any }>;
  attemptsCreated: number;
}
let shopify: FakeShopify;

function fakeAdmin() {
  return {
    graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
      const variables: any = options?.variables ?? {};
      const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? 'unknown';
      shopify.calls.push({ op, variables });
      let data: unknown;
      switch (op) {
        case 'RenewalContract':
          data = {
            subscriptionContract: shopify.contract,
            subscriptionBillingCycles: { nodes: shopify.cycles },
          };
          break;
        case 'ChargeRenewal':
          if (shopify.chargeThrows) throw new Error('socket hang up');
          if (shopify.chargeUserErrors) {
            data = { subscriptionBillingCycleCharge: { subscriptionBillingAttempt: null, userErrors: shopify.chargeUserErrors } };
            break;
          }
          shopify.attemptsCreated += 1;
          data = {
            subscriptionBillingCycleCharge: {
              subscriptionBillingAttempt: { id: `gid://shopify/SubscriptionBillingAttempt/${shopify.attemptsCreated}` },
              userErrors: [],
            },
          };
          break;
        case 'NextRenewalCycle': {
          const next = shopify.cycles.find((c) => c.cycleIndex === variables.index);
          data = { subscriptionBillingCycles: { nodes: next ? [next] : [] } };
          break;
        }
        case 'SetRenewalDate':
          shopify.contract.nextBillingDate = variables.date;
          data = { subscriptionContractSetNextBillingDate: { contract: { id: variables.id }, userErrors: [] } };
          break;
        case 'CancelMemberContract':
          shopify.contract.status = 'CANCELLED';
          data = { subscriptionContractCancel: { contract: { id: variables.id, status: 'CANCELLED' }, userErrors: [] } };
          break;
        default:
          throw new Error(`fake Shopify was asked for ${op}`);
      }
      return Response.json({ data });
    },
  };
}

/** Monthly by default: cycle n is due n months after the contract began. */
function monthlyCycles(count = 3): FakeCycle[] {
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(CREATED);
    date.setUTCMonth(date.getUTCMonth() + i + 1);
    return { cycleIndex: i + 1, billingAttemptExpectedDate: date.toISOString(), status: 'UNBILLED', skipped: false };
  });
}

function reset(overrides: Partial<FakeShopify> = {}) {
  shopify = {
    contract: {
      id: CONTRACT,
      status: 'ACTIVE',
      createdAt: CREATED.toISOString(),
      nextBillingDate: FIRST_RENEWAL.toISOString(),
      billingPolicy: { interval: 'MONTH', intervalCount: 1 },
    },
    cycles: monthlyCycles(),
    calls: [],
    attemptsCreated: 0,
    ...overrides,
  };
}

const charges = () => shopify.calls.filter((call) => call.op === 'ChargeRenewal');
const adminFor = async () => fakeAdmin();

before(async () => {
  if (!CONNECTION) return;
  pool = new pg.Pool({ connectionString: CONNECTION, max: 4 });
  // The Shopify session store creates this itself in production.
  await pool.query(
    `create table if not exists shopify_sessions (
       id varchar(255) primary key, shop varchar(255) not null, state varchar(255) not null,
       "isOnline" boolean not null, scope varchar(255), expires integer, "accessToken" varchar(255),
       "userId" bigint)`,
  );
  billing = await import('../app/lib/renewal-billing.ts');
  const { shopAdmin } = await import('../app/shop-admin.server.ts');
  shopAdmin.forShop = adminFor;
  ({ loader: cronLoader } = await import('../app/routes/cron.billing.ts'));
});

after(async () => {
  if (!CONNECTION) return;
  if (pool) await pool.end();
  const { default: appPool } = await import('../app/db.server.ts');
  await appPool.end();
});

beforeEach(async () => {
  if (!CONNECTION) return;
  reset();
  await pool.query('truncate members, memberships, wigs, service_requests, allowance_ledger, events, billing_attempts cascade');
  await pool.query('truncate shopify_sessions');
  await pool.query(
    `insert into shopify_sessions (id, shop, state, "isOnline", "accessToken")
     values ($1, $2, 'state', false, 'test-token')`,
    [`offline_${SHOP}`, SHOP],
  );
});

async function seedMembership(opts: { shop?: string; nextBillingAt?: Date; contractId?: string } = {}) {
  const member = await pool.query(
    `insert into members (shop, shopify_customer_id) values ($1, $2) returning id`,
    [opts.shop ?? SHOP, CUSTOMER],
  );
  const membership = await pool.query(
    `insert into memberships (member_id, shopify_contract_id, tier, status, membership_year_start,
                              membership_year_end, next_billing_at)
     values ($1, $2, 'Essential Care', 'active', current_date, current_date + interval '1 year', $3) returning id`,
    [member.rows[0].id, opts.contractId ?? CONTRACT, opts.nextBillingAt ?? FIRST_RENEWAL],
  );
  return membership.rows[0].id as string;
}

async function attemptRows() {
  const { rows } = await pool.query(
    `select cycle_index, attempt_number, status, idempotency_key, shopify_attempt_id
       from billing_attempts order by cycle_index, attempt_number`,
  );
  return rows;
}

async function eventKinds(membershipId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `select kind from events where membership_id = $1 order by created_at, kind`,
    [membershipId],
  );
  return rows.map((row) => row.kind);
}

const at = (base: Date, days: number) => new Date(base.getTime() + days * DAY);

/** Webhook payload as Shopify sends it, for the attempt the fake created. */
function webhook(attemptNumber: number, extra: Record<string, unknown> = {}) {
  return billing.billingAttemptOutcome({
    admin_graphql_api_id: `gid://shopify/SubscriptionBillingAttempt/${attemptNumber}`,
    admin_graphql_api_subscription_contract_id: CONTRACT,
    ...extra,
  });
}

// ─── Due or not ─────────────────────────────────────────────────────────────

test('a membership not yet due is not charged, and Shopify is not even asked', { skip }, async () => {
  await seedMembership();
  const result = await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, -1));
  assert.deepEqual(result.charged, []);
  assert.deepEqual(shopify.calls, []);
});

test('a due monthly renewal is charged once, on its cycle', { skip }, async () => {
  await seedMembership();
  const result = await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 0.1));

  assert.deepEqual(result.charged, [{ contractId: CONTRACT, cycleIndex: 1, attemptNumber: 1 }]);
  assert.equal(charges().length, 1);
  assert.deepEqual(charges()[0]!.variables, { id: CONTRACT, index: 1 });

  const rows = await attemptRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'requested');
  assert.equal(rows[0].idempotency_key, 'wig-spa-renewal:9001:cycle-1:attempt-1');
  assert.equal(rows[0].shopify_attempt_id, 'gid://shopify/SubscriptionBillingAttempt/1');
});

test('running the job again before the outcome arrives charges nothing more', { skip }, async () => {
  await seedMembership();
  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 0.1));
  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 0.2));
  assert.equal(charges().length, 1);
});

test('two runs at the same moment charge the cycle once', { skip }, async () => {
  await seedMembership();
  const now = at(FIRST_RENEWAL, 0.1);
  const results = await Promise.all([
    billing.chargeDueRenewals(pool, adminFor, now),
    billing.chargeDueRenewals(pool, adminFor, now),
    billing.chargeDueRenewals(pool, adminFor, now),
  ]);
  assert.equal(charges().length, 1);
  assert.equal(results.flatMap((r) => r.charged).length, 1);
  assert.equal((await attemptRows()).length, 1);
});

test('a store with no offline session is not billed', { skip }, async () => {
  await seedMembership({ shop: 'some-other-store.myshopify.com' });
  const result = await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 1));
  assert.deepEqual(result.charged, []);
  assert.deepEqual(shopify.calls, []);
});

test('a contract Shopify already shows as paused is not charged', { skip }, async () => {
  await seedMembership();
  shopify.contract.status = 'PAUSED';
  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 1));
  assert.equal(charges().length, 0);
});

test('an annual membership is not charged a month in, and is charged at twelve', { skip }, async () => {
  const yearOn = new Date('2027-10-25T15:00:00Z');
  reset({
    cycles: [{ cycleIndex: 1, billingAttemptExpectedDate: yearOn.toISOString(), status: 'UNBILLED', skipped: false }],
  });
  shopify.contract.billingPolicy = { interval: 'YEAR', intervalCount: 1 };
  shopify.contract.nextBillingDate = yearOn.toISOString();
  await seedMembership({ nextBillingAt: yearOn });

  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 1));
  assert.equal(charges().length, 0);

  await billing.chargeDueRenewals(pool, adminFor, at(yearOn, 0.1));
  assert.equal(charges().length, 1);
  assert.deepEqual(charges()[0]!.variables, { id: CONTRACT, index: 1 });
});

// ─── Refusals and lost requests ─────────────────────────────────────────────

test('a charge Shopify refuses is released and asked for again next run', { skip }, async () => {
  await seedMembership();
  shopify.chargeUserErrors = [{ field: ['base'], message: 'Billing attempt rate limit exceeded', code: 'THROTTLED' }];
  const first = await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 0.1));
  assert.equal(first.failed.length, 1);
  assert.equal((await attemptRows()).length, 0);

  shopify.chargeUserErrors = undefined;
  const second = await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 0.2));
  assert.equal(second.charged.length, 1);
  assert.equal((await attemptRows())[0].attempt_number, 1);
});

test('a charge that got no answer is held, then released a day later', { skip }, async () => {
  const membershipId = await seedMembership();
  shopify.chargeThrows = true;
  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 0.1));
  // It may be on its way: nothing more is sent while it could still land.
  shopify.chargeThrows = false;
  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 0.5));
  assert.equal(charges().length, 1);
  assert.equal((await attemptRows())[0].status, 'requested');

  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 1.2));
  assert.equal((await attemptRows()).length, 0);
  assert.ok((await eventKinds(membershipId)).includes('membership_renewal_unresolved'));

  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 1.3));
  assert.equal(charges().length, 2);
});

// ─── Outcomes ───────────────────────────────────────────────────────────────

test('a successful renewal is recorded and the next billing date moves on', { skip }, async () => {
  const membershipId = await seedMembership();
  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 0.1));

  const handled = await billing.handleBillingSuccess(pool, fakeAdmin(), webhook(1, { order_id: 5551 }));
  assert.equal(handled, 'recorded');

  const rows = await attemptRows();
  assert.equal(rows[0].status, 'succeeded');
  assert.deepEqual(await eventKinds(membershipId), ['membership_renewed']);

  const { rows: events } = await pool.query(`select payload from events where membership_id = $1`, [membershipId]);
  assert.equal(events[0].payload.order, 'gid://shopify/Order/5551');
  assert.equal(events[0].payload.cycleIndex, 1);

  const moved = shopify.calls.find((call) => call.op === 'SetRenewalDate');
  assert.equal(moved?.variables.date, '2026-12-25T15:00:00.000Z');
  const { rows: ms } = await pool.query(`select next_billing_at from memberships where id = $1`, [membershipId]);
  assert.equal(new Date(ms[0].next_billing_at).toISOString(), '2026-12-25T15:00:00.000Z');

  // Paid up: the next run leaves the member alone until December.
  shopify.cycles[0]!.status = 'BILLED';
  shopify.calls = [];
  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 2));
  assert.deepEqual(shopify.calls, []);
});

test('a success delivered twice records one payment', { skip }, async () => {
  const membershipId = await seedMembership();
  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 0.1));
  await billing.handleBillingSuccess(pool, fakeAdmin(), webhook(1));
  assert.equal(await billing.handleBillingSuccess(pool, fakeAdmin(), webhook(1)), 'duplicate');
  assert.deepEqual(await eventKinds(membershipId), ['membership_renewed']);
});

test('a webhook that beats the attempt id being saved still finds its charge', { skip }, async () => {
  const membershipId = await seedMembership();
  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 0.1));
  await pool.query(`update billing_attempts set shopify_attempt_id = null`);
  assert.equal(await billing.handleBillingSuccess(pool, fakeAdmin(), webhook(1)), 'recorded');
  assert.deepEqual(await eventKinds(membershipId), ['membership_renewed']);
});

test('an outcome for a charge this app never asked for is ignored', { skip }, async () => {
  await seedMembership();
  assert.equal(await billing.handleBillingSuccess(pool, fakeAdmin(), webhook(42)), 'unknown');
  assert.equal(await billing.handleBillingFailure(pool, fakeAdmin(), webhook(42)), 'unknown');
});

test('a failing card is retried at 3 and 7 days, then the contract is cancelled', { skip }, async () => {
  const membershipId = await seedMembership();
  const failure = { error_code: 'insufficient_funds', error_message: 'Insufficient funds' };

  // Day 0: charged, fails.
  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 0.1));
  await billing.handleBillingFailure(pool, fakeAdmin(), webhook(1, failure), at(FIRST_RENEWAL, 0.1));
  const { rows: firstEvent } = await pool.query(
    `select payload from events where membership_id = $1 and kind = 'membership_renewal_failed'`,
    [membershipId],
  );
  assert.equal(firstEvent[0].payload.retryAt, at(FIRST_RENEWAL, 3.1).toISOString());
  assert.equal(firstEvent[0].payload.final, false);

  // Day 2: too early for the retry.
  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 2));
  assert.equal(charges().length, 1);

  // Day 3: retried, fails.
  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 3.2));
  assert.equal(charges().length, 2);
  await billing.handleBillingFailure(pool, fakeAdmin(), webhook(2, failure), at(FIRST_RENEWAL, 3.2));

  // Day 6: still waiting. Day 7: last retry, fails.
  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 6));
  assert.equal(charges().length, 2);
  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 7.2));
  assert.equal(charges().length, 3);
  assert.equal(shopify.calls.some((call) => call.op === 'CancelMemberContract'), false);
  await billing.handleBillingFailure(pool, fakeAdmin(), webhook(3, failure), at(FIRST_RENEWAL, 7.2));

  const cancels = shopify.calls.filter((call) => call.op === 'CancelMemberContract');
  assert.equal(cancels.length, 1);
  assert.deepEqual(cancels[0]!.variables, { id: CONTRACT });
  assert.deepEqual(
    (await attemptRows()).map((row) => [row.attempt_number, row.status]),
    [[1, 'failed'], [2, 'failed'], [3, 'failed']],
  );
  const kinds = await eventKinds(membershipId);
  assert.equal(kinds.filter((kind) => kind === 'membership_renewal_failed').length, 3);
  assert.ok(kinds.includes('membership_cancelled_nonpayment'));

  // A redelivered final failure does not cancel a second time.
  await billing.handleBillingFailure(pool, fakeAdmin(), webhook(3, failure), at(FIRST_RENEWAL, 7.3));
  assert.equal(shopify.calls.filter((call) => call.op === 'CancelMemberContract').length, 1);
});

test('a retry that succeeds ends the dunning', { skip }, async () => {
  const membershipId = await seedMembership();
  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 0.1));
  await billing.handleBillingFailure(pool, fakeAdmin(), webhook(1), at(FIRST_RENEWAL, 0.1));
  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 3.2));
  await billing.handleBillingSuccess(pool, fakeAdmin(), webhook(2));
  shopify.cycles[0]!.status = 'BILLED';

  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 7.2));
  assert.equal(charges().length, 2);
  assert.deepEqual(await eventKinds(membershipId), ['membership_renewal_failed', 'membership_renewed']);
});

test('a challenged charge is recorded and retried on the failure schedule', { skip }, async () => {
  const membershipId = await seedMembership();
  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 0.1));
  assert.equal(await billing.handleBillingChallenged(pool, fakeAdmin(), webhook(1), at(FIRST_RENEWAL, 0.1)), 'recorded');
  assert.equal((await attemptRows())[0].status, 'challenged');
  assert.deepEqual(await eventKinds(membershipId), ['membership_renewal_challenged']);

  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 3.2));
  assert.equal(charges().length, 2);
});

test('the cron job cancels a contract the failure webhook could not', { skip }, async () => {
  const membershipId = await seedMembership();
  for (const n of [1, 2, 3]) {
    await pool.query(
      `insert into billing_attempts (membership_id, shop, shopify_contract_id, cycle_index, attempt_number,
                                     idempotency_key, status, requested_at, resolved_at)
       values ($1, $2, $3, 1, $4, $5, 'failed', $6, $6)`,
      [membershipId, SHOP, CONTRACT, n, billing.renewalIdempotencyKey(CONTRACT, 1, n), FIRST_RENEWAL],
    );
  }
  const result = await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 9));
  assert.deepEqual(result.cancelled, [CONTRACT]);
  assert.equal(charges().length, 0);
});

test('a renewal whose date was never moved has it put right, without a charge', { skip }, async () => {
  const membershipId = await seedMembership();
  shopify.cycles[0]!.status = 'BILLED';
  await billing.chargeDueRenewals(pool, adminFor, at(FIRST_RENEWAL, 2));
  assert.equal(charges().length, 0);
  assert.equal(shopify.contract.nextBillingDate, '2026-12-25T15:00:00.000Z');
  const { rows } = await pool.query(`select next_billing_at from memberships where id = $1`, [membershipId]);
  assert.equal(new Date(rows[0].next_billing_at).toISOString(), '2026-12-25T15:00:00.000Z');
});

// ─── The route ──────────────────────────────────────────────────────────────

test('the cron route refuses a request without the secret', { skip }, async () => {
  process.env.CRON_SECRET = 'cron-test-secret';
  await seedMembership({ nextBillingAt: at(new Date(), -1) });
  const response = await cronLoader({
    request: new Request('https://app.example.com/cron/billing', { headers: { authorization: 'Bearer nope' } }),
    params: {},
    context: {},
  });
  assert.equal(response.status, 401);
  assert.deepEqual(shopify.calls, []);
});

test('the cron route charges what is due with the secret', { skip }, async () => {
  process.env.CRON_SECRET = 'cron-test-secret';
  // The route runs at the real time, so date the fixture from now.
  const due = at(new Date(), -0.5);
  const created = new Date(due);
  created.setUTCMonth(created.getUTCMonth() - 1);
  reset({
    cycles: [{ cycleIndex: 1, billingAttemptExpectedDate: due.toISOString(), status: 'UNBILLED', skipped: false }],
  });
  shopify.contract.createdAt = created.toISOString();
  await seedMembership({ nextBillingAt: due });

  const response = await cronLoader({
    request: new Request('https://app.example.com/cron/billing', {
      headers: { authorization: 'Bearer cron-test-secret' },
    }),
    params: {},
    context: {},
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.charged.length, 1);
  assert.equal(charges().length, 1);
});
