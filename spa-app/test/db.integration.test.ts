import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  findOrCreateMember,
  listWigs,
  getMembership,
  getAllowanceBalance,
  createServiceRequest,
  advanceStatus,
  getCloset,
  listOpenWorkOrders,
  getWorkOrder,
  listEvents,
  saveStaffNotes,
} from '../app/lib/db.ts';

/**
 * Runs against a real PostgreSQL instance with the real migration applied —
 * mocks would happily accept SQL the database rejects. Skipped when
 * TEST_DATABASE_URL is unset so the suite stays runnable without one.
 */
const CONNECTION = process.env.TEST_DATABASE_URL;
const skip = CONNECTION ? false : 'TEST_DATABASE_URL not set';

let pool: pg.Pool;

before(async () => {
  if (!CONNECTION) return;
  pool = new pg.Pool({ connectionString: CONNECTION, max: 4 });
});

after(async () => {
  if (pool) await pool.end();
});

beforeEach(async () => {
  if (!CONNECTION) return;
  await pool.query('truncate members, memberships, wigs, service_requests, allowance_ledger, events cascade');
});

async function seedMemberWithMembership(opts: { granted: number; status?: string }) {
  const member = await findOrCreateMember(pool, {
    shopifyCustomerId: 'gid://shopify/Customer/7401',
    email: 'member@example.com',
  });
  const { rows } = await pool.query(
    `insert into memberships (member_id, tier, status, membership_year_start, membership_year_end)
     values ($1, 'founding', $2, current_date, current_date + interval '1 year') returning id`,
    [member.id, opts.status ?? 'active'],
  );
  const membershipId = rows[0].id;
  if (opts.granted > 0) {
    await pool.query(
      `insert into allowance_ledger (membership_id, kind, delta, reason) values ($1, 'grant', $2, 'seed')`,
      [membershipId, opts.granted],
    );
  }
  const wig = await pool.query(
    `insert into wigs (member_id, nickname, is_t_collection, length_inches)
     values ($1, 'Chocolate Body Wave', true, 26) returning id`,
    [member.id],
  );
  return { member, membershipId, wigId: wig.rows[0].id };
}

test('creating a member twice returns the same row', { skip }, async () => {
  const first = await findOrCreateMember(pool, { shopifyCustomerId: 'gid://shopify/Customer/1' });
  const second = await findOrCreateMember(pool, {
    shopifyCustomerId: 'gid://shopify/Customer/1',
    email: 'later@example.com',
  });
  assert.equal(first.id, second.id, 'a returning customer must not become a second member');
  assert.equal(second.email, 'later@example.com', 'later details fill in blanks');
});

test('an upsert never blanks details it was not given', { skip }, async () => {
  await findOrCreateMember(pool, { shopifyCustomerId: 'gid://shopify/Customer/2', email: 'keep@example.com' });
  const again = await findOrCreateMember(pool, { shopifyCustomerId: 'gid://shopify/Customer/2' });
  assert.equal(again.email, 'keep@example.com');
});

test('the closet reads back what was seeded', { skip }, async () => {
  await seedMemberWithMembership({ granted: 2 });
  const closet = await getCloset(pool, 'gid://shopify/Customer/7401');

  assert.equal(closet.membership?.tier, 'founding');
  assert.equal(closet.allowanceRemaining, 2);
  assert.equal(closet.wigs.length, 1);
  assert.equal(closet.wigs[0]?.nickname, 'Chocolate Body Wave');
  assert.equal(closet.wigs[0]?.lastServicedAt, null, 'never serviced reads as null, not a date');
  assert.deepEqual(closet.activeServices, []);
});

test('a covered service spends exactly one allowance at approval', { skip }, async () => {
  const { member, membershipId, wigId } = await seedMemberWithMembership({ granted: 2 });
  const request = await createServiceRequest(pool, {
    memberId: member.id, wigId, membershipId,
    serviceType: 'rejuvenation', coveredByAllowance: true,
  });

  // Nothing is spent while the wig is still in the post.
  await advanceStatus(pool, { serviceRequestId: request.id, to: 'awaiting_shipment', actor: 'tia' });
  await advanceStatus(pool, { serviceRequestId: request.id, to: 'in_transit_to_studio', actor: 'tia' });
  await advanceStatus(pool, { serviceRequestId: request.id, to: 'received', actor: 'tia' });
  await advanceStatus(pool, { serviceRequestId: request.id, to: 'inspection', actor: 'tia' });
  assert.equal(await getAllowanceBalance(pool, membershipId), 2, 'not spent before approval');

  const result = await advanceStatus(pool, { serviceRequestId: request.id, to: 'approved', actor: 'tia' });
  assert.equal(result.allowanceSpent, true);
  assert.equal(await getAllowanceBalance(pool, membershipId), 1);
});

test('an illegal move changes nothing at all', { skip }, async () => {
  const { member, membershipId, wigId } = await seedMemberWithMembership({ granted: 2 });
  const request = await createServiceRequest(pool, {
    memberId: member.id, wigId, membershipId,
    serviceType: 'rejuvenation', coveredByAllowance: true,
  });

  await assert.rejects(
    () => advanceStatus(pool, { serviceRequestId: request.id, to: 'ready_to_ship', actor: 'tia' }),
    /Cannot move/,
  );

  const { rows } = await pool.query('select status from service_requests where id = $1', [request.id]);
  assert.equal(rows[0].status, 'requested', 'status untouched');
  const events = await pool.query('select count(*)::int as n from events where service_request_id = $1', [request.id]);
  assert.equal(events.rows[0].n, 0, 'a rejected move leaves no event behind');
});

test('a lapsed membership blocks approval of a service sold as covered', { skip }, async () => {
  const { member, membershipId, wigId } = await seedMemberWithMembership({ granted: 2, status: 'past_due' });
  const request = await createServiceRequest(pool, {
    memberId: member.id, wigId, membershipId,
    serviceType: 'rejuvenation', coveredByAllowance: true,
  });
  for (const to of ['awaiting_shipment', 'in_transit_to_studio', 'received', 'inspection']) {
    await advanceStatus(pool, { serviceRequestId: request.id, to, actor: 'tia' });
  }

  await assert.rejects(
    () => advanceStatus(pool, { serviceRequestId: request.id, to: 'approved', actor: 'tia' }),
    /not covered: membership_inactive/,
  );

  const { rows } = await pool.query('select status from service_requests where id = $1', [request.id]);
  assert.equal(rows[0].status, 'inspection', 'the whole transaction rolled back');
  assert.equal(await getAllowanceBalance(pool, membershipId), 2, 'nothing deducted');
});

test('an uncovered service advances without touching the ledger', { skip }, async () => {
  const { member, membershipId, wigId } = await seedMemberWithMembership({ granted: 0 });
  const request = await createServiceRequest(pool, {
    memberId: member.id, wigId, membershipId,
    serviceType: 'reconstruction', coveredByAllowance: false,
  });
  for (const to of ['awaiting_shipment', 'in_transit_to_studio', 'received', 'inspection']) {
    await advanceStatus(pool, { serviceRequestId: request.id, to, actor: 'tia' });
  }
  const result = await advanceStatus(pool, { serviceRequestId: request.id, to: 'approved', actor: 'tia' });
  assert.equal(result.allowanceSpent, false);
  assert.equal(await getAllowanceBalance(pool, membershipId), 0);
});

test('two simultaneous advances produce one move, not two', { skip }, async () => {
  const { member, membershipId, wigId } = await seedMemberWithMembership({ granted: 2 });
  const request = await createServiceRequest(pool, {
    memberId: member.id, wigId, membershipId,
    serviceType: 'rejuvenation', coveredByAllowance: true,
  });

  // Both callers read 'requested' and both try to move it. The row lock means
  // the second one re-reads after the first commits and is rejected.
  const results = await Promise.allSettled([
    advanceStatus(pool, { serviceRequestId: request.id, to: 'awaiting_shipment', actor: 'a' }),
    advanceStatus(pool, { serviceRequestId: request.id, to: 'awaiting_shipment', actor: 'b' }),
  ]);
  const succeeded = results.filter((r) => r.status === 'fulfilled');
  assert.equal(succeeded.length, 1, 'exactly one advance wins');

  const events = await pool.query('select count(*)::int as n from events where service_request_id = $1', [request.id]);
  assert.equal(events.rows[0].n, 1, 'one move, one event');
});

test('the work queue sorts by how long something has been sitting', { skip }, async () => {
  const { member, membershipId, wigId } = await seedMemberWithMembership({ granted: 4 });
  const older = await createServiceRequest(pool, {
    memberId: member.id, wigId, membershipId, serviceType: 'rejuvenation', coveredByAllowance: true,
  });
  const newer = await createServiceRequest(pool, {
    memberId: member.id, wigId, membershipId, serviceType: 'repair', coveredByAllowance: false,
  });
  // Move the newer one so its clock resets; the older one has sat untouched.
  await advanceStatus(pool, { serviceRequestId: newer.id, to: 'awaiting_shipment', actor: 'tia' });

  const queue = await listOpenWorkOrders(pool);
  assert.equal(queue.length, 2);
  assert.equal(queue[0]?.id, older.id, 'the one waiting longest comes first');
});

test('completed work leaves the queue and dates the wig', { skip }, async () => {
  const { member, membershipId, wigId } = await seedMemberWithMembership({ granted: 2 });
  const request = await createServiceRequest(pool, {
    memberId: member.id, wigId, membershipId, serviceType: 'rejuvenation', coveredByAllowance: true,
  });
  for (const to of ['awaiting_shipment', 'in_transit_to_studio', 'received', 'inspection',
                    'approved', 'in_service', 'quality_check', 'ready_to_ship',
                    'return_shipment', 'delivered', 'completed']) {
    await advanceStatus(pool, { serviceRequestId: request.id, to, actor: 'tia' });
  }
  assert.deepEqual(await listOpenWorkOrders(pool), []);
  const wigs = await listWigs(pool, member.id);
  assert.notEqual(wigs[0]?.lastServicedAt, null, 'the wig now has a service date');
});

test('membership reads back even when it is not active', { skip }, async () => {
  const { member } = await seedMemberWithMembership({ granted: 0, status: 'past_due' });
  const membership = await getMembership(pool, member.id);
  assert.equal(membership?.status, 'past_due',
    'so the closet can say "past due" rather than "no membership"');
});

test('a work order reads back with its wig, member and membership', { skip }, async () => {
  const { member, membershipId, wigId } = await seedMemberWithMembership({ granted: 3 });
  const request = await createServiceRequest(pool, {
    memberId: member.id, wigId, membershipId,
    serviceType: 'rejuvenation', coveredByAllowance: true,
    customerNotes: 'lace lifting at the temples',
    intake: { desiredPart: 'middle', hasBeenColored: false },
  });

  const order = await getWorkOrder(pool, request.id);
  assert.ok(order);
  assert.equal(order.wig.nickname, 'Chocolate Body Wave');
  assert.equal(order.wig.lengthInches, 26);
  assert.equal(order.member.shopifyCustomerId, 'gid://shopify/Customer/7401');
  assert.equal(order.membership?.tier, 'founding');
  assert.equal(order.membership?.allowanceRemaining, 3);
  assert.equal(order.customerNotes, 'lace lifting at the temples');
  assert.deepEqual(order.intake, { desiredPart: 'middle', hasBeenColored: false });
});

test('a work order without a membership still reads back', { skip }, async () => {
  // A non-member sending a wig in is a normal, paying customer. An inner join
  // on memberships would make them vanish from the studio's queue entirely.
  const member = await findOrCreateMember(pool, { shopifyCustomerId: 'gid://shopify/Customer/999' });
  const wig = await pool.query(
    `insert into wigs (member_id, nickname) values ($1, 'Walk-in unit') returning id`,
    [member.id],
  );
  const request = await createServiceRequest(pool, {
    memberId: member.id, wigId: wig.rows[0].id, membershipId: null,
    serviceType: 'reconstruction', coveredByAllowance: false,
  });

  const order = await getWorkOrder(pool, request.id);
  assert.ok(order);
  assert.equal(order.membership, null);
  assert.equal(order.coveredByAllowance, false);
});

test('an unknown work order is null, not an error', { skip }, async () => {
  assert.equal(await getWorkOrder(pool, '00000000-0000-0000-0000-000000000000'), null);
});

test('the event trail records every move, newest first', { skip }, async () => {
  const { member, membershipId, wigId } = await seedMemberWithMembership({ granted: 2 });
  const request = await createServiceRequest(pool, {
    memberId: member.id, wigId, membershipId, serviceType: 'rejuvenation', coveredByAllowance: true,
  });
  await advanceStatus(pool, { serviceRequestId: request.id, to: 'awaiting_shipment', actor: 'tia' });
  await advanceStatus(pool, { serviceRequestId: request.id, to: 'in_transit_to_studio', actor: 'tia', note: 'UPS 1Z999' });

  const events = await listEvents(pool, request.id);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.toStatus, 'in_transit_to_studio', 'newest first');
  assert.equal(events[0]?.note, 'UPS 1Z999');
  assert.equal(events[1]?.toStatus, 'awaiting_shipment');
  assert.equal(events[1]?.actor, 'tia');
});

test('editing staff notes is itself recorded', { skip }, async () => {
  const { member, membershipId, wigId } = await seedMemberWithMembership({ granted: 1 });
  const request = await createServiceRequest(pool, {
    memberId: member.id, wigId, membershipId, serviceType: 'repair', coveredByAllowance: true,
  });

  await saveStaffNotes(pool, { serviceRequestId: request.id, notes: 'Knots need bleaching', actor: 'tia' });
  const order = await getWorkOrder(pool, request.id);
  assert.equal(order?.staffNotes, 'Knots need bleaching');

  const events = await listEvents(pool, request.id);
  assert.equal(events[0]?.kind, 'staff_notes_edited',
    'an edit leaves a trace even though the notes themselves are overwritten');
  assert.equal(events[0]?.actor, 'tia');
});

test('saving notes on a missing work order fails rather than silently doing nothing', { skip }, async () => {
  await assert.rejects(
    () => saveStaffNotes(pool, {
      serviceRequestId: '00000000-0000-0000-0000-000000000000',
      notes: 'x', actor: 'tia',
    }),
    /No service request/,
  );
});
