import { assertTransition, consumesAllowanceOn, type ServiceStatus } from './service-status.ts';
import { balanceOf, consumptionEntry, type LedgerEntry, type MembershipWindow } from './allowance.ts';

/**
 * Data access for the Wig Spa.
 *
 * Every function takes its connection rather than reaching for a module-level
 * pool, so a route can hand in the shared pool, a transaction can hand in its
 * own client, and a test can hand in a throwaway database. Nothing here knows
 * about Shopify beyond the customer GID it is given.
 *
 * Rules live in service-status.ts and allowance.ts and are called from here.
 * They are never re-implemented in SQL — one statement of the rule, so what a
 * member is told and what they are charged cannot drift.
 */

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export interface Transactable extends Queryable {
  connect(): Promise<PoolClientLike>;
}

interface PoolClientLike extends Queryable {
  release(): void;
}

export interface Member {
  id: string;
  shopifyCustomerId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface Wig {
  id: string;
  nickname: string;
  isTCollection: boolean;
  brand: string | null;
  lengthInches: number | null;
  texture: string | null;
  color: string | null;
  photoPath: string | null;
  lastServicedAt: string | null;
}

export interface Membership extends MembershipWindow {
  id: string;
  tier: string;
  nextBillingAt: Date | null;
}

export interface ServiceRequestSummary {
  id: string;
  wigId: string;
  wigNickname: string;
  serviceType: string;
  status: ServiceStatus;
  coveredByAllowance: boolean;
  submittedAt: Date;
  statusSince: Date;
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  pool: Transactable,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The member behind a proxy request.
 *
 * Upserts because the first time a customer reaches the app they exist in
 * Shopify but not here. The GID is the join key — it is what the signed proxy
 * request gives us, and unlike an email it never changes.
 */
export async function findOrCreateMember(
  db: Queryable,
  input: { shopifyCustomerId: string; email?: string | null; firstName?: string | null; lastName?: string | null },
): Promise<Member> {
  const { rows } = await db.query(
    `insert into members (shopify_customer_id, email, first_name, last_name)
     values ($1, $2, $3, $4)
     on conflict (shopify_customer_id) do update
       set email      = coalesce(excluded.email, members.email),
           first_name = coalesce(excluded.first_name, members.first_name),
           last_name  = coalesce(excluded.last_name, members.last_name)
     returning id, shopify_customer_id, email, first_name, last_name`,
    [input.shopifyCustomerId, input.email ?? null, input.firstName ?? null, input.lastName ?? null],
  );
  const row = rows[0];
  return {
    id: row.id,
    shopifyCustomerId: row.shopify_customer_id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
  };
}

export async function listWigs(db: Queryable, memberId: string): Promise<Wig[]> {
  const { rows } = await db.query(
    `select w.id, w.nickname, w.is_t_collection, w.brand, w.length_inches,
            w.texture, w.color, w.photo_path,
            (select max(sr.completed_at)
               from service_requests sr
              where sr.wig_id = w.id and sr.status = 'completed') as last_serviced_at
       from wigs w
      where w.member_id = $1 and w.retired_at is null
      order by w.created_at`,
    [memberId],
  );
  return rows.map((row) => ({
    id: row.id,
    nickname: row.nickname,
    isTCollection: row.is_t_collection,
    brand: row.brand,
    lengthInches: row.length_inches,
    texture: row.texture,
    color: row.color,
    photoPath: row.photo_path,
    lastServicedAt: row.last_serviced_at ? new Date(row.last_serviced_at).toISOString() : null,
  }));
}

/**
 * The membership to charge allowances against.
 *
 * Returns the active one if there is one. A lapsed membership is deliberately
 * still returned when nothing is active, so the closet can say "your
 * membership is past due" rather than "you have no membership" — those are
 * very different messages to send someone who is still being billed.
 */
export async function getMembership(db: Queryable, memberId: string): Promise<Membership | null> {
  const { rows } = await db.query(
    `select id, tier, status, membership_year_start, membership_year_end, next_billing_at
       from memberships
      where member_id = $1
      order by (status = 'active') desc, membership_year_end desc
      limit 1`,
    [memberId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    tier: row.tier,
    status: row.status,
    membershipYearStart: new Date(row.membership_year_start),
    membershipYearEnd: new Date(row.membership_year_end),
    nextBillingAt: row.next_billing_at ? new Date(row.next_billing_at) : null,
  };
}

export async function getAllowanceEntries(db: Queryable, membershipId: string): Promise<LedgerEntry[]> {
  const { rows } = await db.query(
    `select kind, delta, service_request_id, reason
       from allowance_ledger
      where membership_id = $1
      order by created_at`,
    [membershipId],
  );
  return rows.map((row) => ({
    kind: row.kind,
    delta: row.delta,
    serviceRequestId: row.service_request_id,
    reason: row.reason,
  }));
}

export async function getAllowanceBalance(db: Queryable, membershipId: string): Promise<number> {
  const { rows } = await db.query(
    `select coalesce(balance, 0) as balance
       from membership_allowance_balance
      where membership_id = $1`,
    [membershipId],
  );
  return rows[0]?.balance ?? 0;
}

export async function createServiceRequest(
  db: Queryable,
  input: {
    memberId: string;
    wigId: string;
    membershipId: string | null;
    serviceType: string;
    coveredByAllowance: boolean;
    intake?: Record<string, unknown>;
    customerNotes?: string | null;
  },
): Promise<{ id: string; status: ServiceStatus }> {
  const { rows } = await db.query(
    `insert into service_requests
       (member_id, wig_id, membership_id, service_type, covered_by_allowance, intake, customer_notes)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id, status`,
    [
      input.memberId,
      input.wigId,
      input.membershipId,
      input.serviceType,
      input.coveredByAllowance,
      JSON.stringify(input.intake ?? {}),
      input.customerNotes ?? null,
    ],
  );
  return { id: rows[0].id, status: rows[0].status };
}

/**
 * Move a work order to its next status.
 *
 * Everything happens in one transaction: the row is locked, the move is
 * checked against the status graph, the status is written, an events row
 * records who did it, and — if this is the moment the work is authorised —
 * the allowance is spent. A rejected move leaves nothing behind.
 *
 * The lock matters. Two people clicking "advance" at once would otherwise
 * both read `in_service` and both write `quality_check`, producing two events
 * for one move.
 */
export async function advanceStatus(
  pool: Transactable,
  input: { serviceRequestId: string; to: string; actor: string; note?: string },
): Promise<{ from: ServiceStatus; to: ServiceStatus; allowanceSpent: boolean }> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query(
      `select id, member_id, membership_id, status, covered_by_allowance
         from service_requests
        where id = $1
        for update`,
      [input.serviceRequestId],
    );
    const request = rows[0];
    if (!request) throw new Error(`No service request ${input.serviceRequestId}`);

    const from = request.status as ServiceStatus;
    assertTransition(from, input.to);
    const to = input.to;

    let allowanceSpent = false;

    if (consumesAllowanceOn(to) && request.covered_by_allowance) {
      if (!request.membership_id) {
        throw new Error('Request is marked covered by allowance but has no membership attached');
      }
      const membership = await getMembershipById(tx, request.membership_id);
      const entries = await getAllowanceEntries(tx, request.membership_id);

      // Throws when the request was promised as covered but no longer is —
      // a lapsed membership, or an allowance spent elsewhere since. Better
      // Tia finds out now than after $200 of labour.
      const entry = consumptionEntry({
        membership,
        entries,
        serviceRequestId: request.id,
      });

      await tx.query(
        `insert into allowance_ledger (membership_id, service_request_id, kind, delta, created_by)
         values ($1, $2, $3, $4, $5)`,
        [request.membership_id, request.id, entry.kind, entry.delta, input.actor],
      );
      allowanceSpent = true;
    }

    await tx.query(
      // Every use of $2 is cast to the enum. Without the casts Postgres sees it
      // as an enum in one clause and text in the others and refuses to deduce
      // a single type for the parameter.
      `update service_requests
          set status = $2::service_status,
              received_at  = case when $2::service_status = 'received'  then now() else received_at  end,
              completed_at = case when $2::service_status = 'completed' then now() else completed_at end
        where id = $1`,
      [request.id, to],
    );

    await tx.query(
      `insert into events (service_request_id, kind, from_status, to_status, actor, payload)
       values ($1, 'status_changed', $2::service_status, $3::service_status, $4, $5::jsonb)`,
      [request.id, from, to, input.actor, JSON.stringify(input.note ? { note: input.note } : {})],
    );

    return { from, to, allowanceSpent };
  });
}

async function getMembershipById(db: Queryable, membershipId: string): Promise<Membership | null> {
  const { rows } = await db.query(
    `select id, tier, status, membership_year_start, membership_year_end, next_billing_at
       from memberships where id = $1`,
    [membershipId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    tier: row.tier,
    status: row.status,
    membershipYearStart: new Date(row.membership_year_start),
    membershipYearEnd: new Date(row.membership_year_end),
    nextBillingAt: row.next_billing_at ? new Date(row.next_billing_at) : null,
  };
}

/** Everything the Wig Closet renders, in one round trip's worth of queries. */
export async function getCloset(
  db: Queryable,
  shopifyCustomerId: string,
): Promise<{
  member: Member;
  membership: Membership | null;
  allowanceRemaining: number;
  wigs: Wig[];
  activeServices: ServiceRequestSummary[];
}> {
  const member = await findOrCreateMember(db, { shopifyCustomerId });
  const membership = await getMembership(db, member.id);
  const [wigs, activeServices, allowanceRemaining] = await Promise.all([
    listWigs(db, member.id),
    listActiveServices(db, member.id),
    membership ? getAllowanceBalance(db, membership.id) : Promise.resolve(0),
  ]);
  return { member, membership, allowanceRemaining, wigs, activeServices };
}

export async function listActiveServices(db: Queryable, memberId: string): Promise<ServiceRequestSummary[]> {
  const { rows } = await db.query(
    `select sr.id, sr.wig_id, w.nickname as wig_nickname, sr.service_type, sr.status,
            sr.covered_by_allowance, sr.submitted_at,
            coalesce((select max(e.created_at) from events e where e.service_request_id = sr.id),
                     sr.submitted_at) as status_since
       from service_requests sr
       join wigs w on w.id = sr.wig_id
      where sr.member_id = $1
        and sr.status not in ('completed', 'cancelled')
      order by sr.submitted_at desc`,
    [memberId],
  );
  return rows.map(toSummary);
}

function toSummary(row: any): ServiceRequestSummary {
  return {
    id: row.id,
    wigId: row.wig_id,
    wigNickname: row.wig_nickname,
    serviceType: row.service_type,
    status: row.status,
    coveredByAllowance: row.covered_by_allowance,
    submittedAt: new Date(row.submitted_at),
    statusSince: new Date(row.status_since),
  };
}

/**
 * Everything currently open in the studio, oldest-waiting first.
 *
 * `statusSince` is when the work order last moved, not when it was submitted —
 * that is what "sitting too long" actually means. A wig submitted in January
 * that moved yesterday is fine; one that moved three weeks ago is not.
 */
export async function listOpenWorkOrders(db: Queryable): Promise<ServiceRequestSummary[]> {
  const { rows } = await db.query(
    `select sr.id, sr.wig_id, w.nickname as wig_nickname, sr.service_type, sr.status,
            sr.covered_by_allowance, sr.submitted_at,
            coalesce((select max(e.created_at) from events e where e.service_request_id = sr.id),
                     sr.submitted_at) as status_since
       from service_requests sr
       join wigs w on w.id = sr.wig_id
      where sr.status not in ('completed', 'cancelled')
      order by status_since asc`,
  );
  return rows.map(toSummary);
}

export function balanceFromEntries(entries: readonly LedgerEntry[]): number {
  return balanceOf(entries);
}

export interface WorkOrderEvent {
  id: string;
  kind: string;
  fromStatus: ServiceStatus | null;
  toStatus: ServiceStatus | null;
  actor: string;
  note: string | null;
  createdAt: Date;
}

export interface WorkOrder {
  id: string;
  status: ServiceStatus;
  serviceType: string;
  coveredByAllowance: boolean;
  intake: Record<string, unknown>;
  customerNotes: string | null;
  staffNotes: string | null;
  submittedAt: Date;
  receivedAt: Date | null;
  completedAt: Date | null;
  wig: {
    id: string;
    nickname: string;
    isTCollection: boolean;
    brand: string | null;
    lengthInches: number | null;
    texture: string | null;
    color: string | null;
    laceType: string | null;
    capSize: string | null;
  };
  member: {
    id: string;
    shopifyCustomerId: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  };
  membership: {
    id: string;
    tier: string;
    status: MembershipWindow['status'];
    allowanceRemaining: number;
  } | null;
}

/** One work order with everything the detail screen shows, in one query each. */
export async function getWorkOrder(db: Queryable, id: string): Promise<WorkOrder | null> {
  const { rows } = await db.query(
    `select sr.id, sr.status, sr.service_type, sr.covered_by_allowance, sr.intake,
            sr.customer_notes, sr.staff_notes, sr.submitted_at, sr.received_at, sr.completed_at,
            w.id as wig_id, w.nickname, w.is_t_collection, w.brand, w.length_inches,
            w.texture, w.color, w.lace_type, w.cap_size,
            m.id as member_id, m.shopify_customer_id, m.email, m.first_name, m.last_name,
            ms.id as membership_id, ms.tier, ms.status as membership_status
       from service_requests sr
       join wigs w    on w.id = sr.wig_id
       join members m on m.id = sr.member_id
       left join memberships ms on ms.id = sr.membership_id
      where sr.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;

  // Read the balance separately rather than joining the view — a member with no
  // membership must still produce a work order, and an inner join would drop it.
  const allowanceRemaining = row.membership_id
    ? await getAllowanceBalance(db, row.membership_id)
    : 0;

  return {
    id: row.id,
    status: row.status,
    serviceType: row.service_type,
    coveredByAllowance: row.covered_by_allowance,
    intake: row.intake ?? {},
    customerNotes: row.customer_notes,
    staffNotes: row.staff_notes,
    submittedAt: new Date(row.submitted_at),
    receivedAt: row.received_at ? new Date(row.received_at) : null,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    wig: {
      id: row.wig_id,
      nickname: row.nickname,
      isTCollection: row.is_t_collection,
      brand: row.brand,
      lengthInches: row.length_inches,
      texture: row.texture,
      color: row.color,
      laceType: row.lace_type,
      capSize: row.cap_size,
    },
    member: {
      id: row.member_id,
      shopifyCustomerId: row.shopify_customer_id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
    },
    membership: row.membership_id
      ? {
          id: row.membership_id,
          tier: row.tier,
          status: row.membership_status,
          allowanceRemaining,
        }
      : null,
  };
}

/** The audit trail, newest first — who moved what, when. */
export async function listEvents(db: Queryable, serviceRequestId: string): Promise<WorkOrderEvent[]> {
  const { rows } = await db.query(
    `select id, kind, from_status, to_status, actor, payload, created_at
       from events
      where service_request_id = $1
      order by created_at desc`,
    [serviceRequestId],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actor: row.actor,
    note: row.payload?.note ?? null,
    createdAt: new Date(row.created_at),
  }));
}

/**
 * Staff notes are working notes, so they are edited in place rather than
 * appended — but the edit itself is recorded, because "the notes said something
 * different yesterday" is exactly the kind of thing a dispute turns on.
 */
export async function saveStaffNotes(
  pool: Transactable,
  input: { serviceRequestId: string; notes: string; actor: string },
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    const { rowCount } = await tx.query(
      `update service_requests set staff_notes = $2 where id = $1`,
      [input.serviceRequestId, input.notes],
    );
    if (rowCount === 0) throw new Error(`No service request ${input.serviceRequestId}`);

    await tx.query(
      `insert into events (service_request_id, kind, actor, payload)
       values ($1, 'staff_notes_edited', $2, $3::jsonb)`,
      [input.serviceRequestId, input.actor, JSON.stringify({ length: input.notes.length })],
    );
  });
}

// ---------------------------------------------------------------------------
// Wig detail — everything behind one unit card in the closet
// ---------------------------------------------------------------------------

export interface WigDetailPhoto {
  id: string;
  kind: string;
  storagePath: string;
  caption: string | null;
  createdAt: Date;
}

export interface WigDetailEvent {
  kind: string;
  fromStatus: ServiceStatus | null;
  toStatus: ServiceStatus | null;
  createdAt: Date;
}

export interface WigDetailInspection {
  assessment: string | null;
  recommendedWork: string | null;
  additionalCostCents: number | null;
  currency: string;
  customerApproved: boolean | null;
  customerRespondedAt: Date | null;
}

export interface WigDetailService {
  id: string;
  serviceType: string;
  status: ServiceStatus;
  coveredByAllowance: boolean;
  customerNotes: string | null;
  studioNotes: string | null;
  submittedAt: Date;
  receivedAt: Date | null;
  completedAt: Date | null;
  events: WigDetailEvent[];
  inspection: WigDetailInspection | null;
}

export interface WigDetail {
  wig: Wig & {
    laceType: string | null;
    capSize: string | null;
    purchasedOn: string | null;
    notes: string | null;
  };
  services: WigDetailService[];
  photos: WigDetailPhoto[];
}

/**
 * One unit and its whole history.
 *
 * `memberId` is not a filter of convenience — it is the ownership check. The
 * wig id arrives from the browser, so a member editing it must get nothing
 * back rather than someone else's unit. Returns null when the wig is not
 * theirs, which the route reports the same way it reports "no such wig":
 * telling the difference would confirm the id exists.
 *
 * Only `customer_visible` photos come back. Arrival documentation is written
 * for the studio's protection first, and defaults to private.
 */
export async function getWigDetail(
  db: Queryable,
  memberId: string,
  wigId: string,
): Promise<WigDetail | null> {
  const { rows: wigRows } = await db.query(
    `select w.id, w.nickname, w.is_t_collection, w.brand, w.length_inches,
            w.texture, w.color, w.lace_type, w.cap_size, w.purchased_on,
            w.photo_path, w.notes,
            (select max(sr.completed_at)
               from service_requests sr
              where sr.wig_id = w.id and sr.status = 'completed') as last_serviced_at
       from wigs w
      where w.id = $1 and w.member_id = $2 and w.retired_at is null`,
    [wigId, memberId],
  );
  if (wigRows.length === 0) return null;
  const w = wigRows[0];

  const { rows: serviceRows } = await db.query(
    `select sr.id, sr.service_type, sr.status, sr.covered_by_allowance,
            sr.customer_notes, sr.studio_notes,
            sr.submitted_at, sr.received_at, sr.completed_at
       from service_requests sr
      where sr.wig_id = $1 and sr.member_id = $2
      order by sr.submitted_at desc`,
    [wigId, memberId],
  );

  const serviceIds = serviceRows.map((r: any) => r.id);

  // Two grouped reads rather than one per service — a unit with a long history
  // would otherwise fan out into a query per row.
  const eventsByService = new Map<string, WigDetailEvent[]>();
  const inspectionByService = new Map<string, WigDetailInspection>();

  if (serviceIds.length > 0) {
    const { rows: eventRows } = await db.query(
      `select service_request_id, kind, from_status, to_status, created_at
         from events
        where service_request_id = any($1::uuid[])
        order by created_at asc`,
      [serviceIds],
    );
    for (const row of eventRows) {
      const list = eventsByService.get(row.service_request_id) ?? [];
      list.push({
        kind: row.kind,
        fromStatus: row.from_status,
        toStatus: row.to_status,
        createdAt: new Date(row.created_at),
      });
      eventsByService.set(row.service_request_id, list);
    }

    // Latest inspection per request — a correction is a new row, not an edit.
    const { rows: inspectionRows } = await db.query(
      `select distinct on (service_request_id)
              service_request_id, assessment, recommended_work,
              additional_cost_cents, currency, customer_approved, customer_responded_at
         from inspections
        where service_request_id = any($1::uuid[])
        order by service_request_id, created_at desc`,
      [serviceIds],
    );
    for (const row of inspectionRows) {
      inspectionByService.set(row.service_request_id, {
        assessment: row.assessment,
        recommendedWork: row.recommended_work,
        additionalCostCents: row.additional_cost_cents,
        currency: row.currency,
        customerApproved: row.customer_approved,
        customerRespondedAt: row.customer_responded_at ? new Date(row.customer_responded_at) : null,
      });
    }
  }

  const { rows: photoRows } = await db.query(
    `select id, kind, storage_path, caption, created_at
       from photos
      where wig_id = $1 and member_id = $2 and customer_visible = true
      order by created_at desc`,
    [wigId, memberId],
  );

  return {
    wig: {
      id: w.id,
      nickname: w.nickname,
      isTCollection: w.is_t_collection,
      brand: w.brand,
      lengthInches: w.length_inches,
      texture: w.texture,
      color: w.color,
      laceType: w.lace_type,
      capSize: w.cap_size,
      purchasedOn: w.purchased_on ? new Date(w.purchased_on).toISOString() : null,
      photoPath: w.photo_path,
      notes: w.notes,
      lastServicedAt: w.last_serviced_at ? new Date(w.last_serviced_at).toISOString() : null,
    },
    services: serviceRows.map((row: any) => ({
      id: row.id,
      serviceType: row.service_type,
      status: row.status,
      coveredByAllowance: row.covered_by_allowance,
      customerNotes: row.customer_notes,
      studioNotes: row.studio_notes,
      submittedAt: new Date(row.submitted_at),
      receivedAt: row.received_at ? new Date(row.received_at) : null,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
      events: eventsByService.get(row.id) ?? [],
      inspection: inspectionByService.get(row.id) ?? null,
    })),
    photos: photoRows.map((row: any) => ({
      id: row.id,
      kind: row.kind,
      storagePath: row.storage_path,
      caption: row.caption,
      createdAt: new Date(row.created_at),
    })),
  };
}

/**
 * The member's answer to "we found more work — shall we?".
 *
 * Records the decision against the inspection and moves the work order off
 * `awaiting_customer_approval`. Money is deliberately not touched here: raising
 * the draft order for the extra cost is a separate step that needs the Admin
 * API, and a decision recorded twice must not bill twice.
 *
 * The ownership check is in the WHERE clause rather than a prior read, so a
 * member cannot answer for someone else's inspection between the two.
 */
export async function recordInspectionDecision(
  pool: Transactable,
  input: { memberId: string; serviceRequestId: string; approved: boolean },
): Promise<'recorded' | 'not_found' | 'already_answered'> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query(
      `select sr.id, sr.status, i.id as inspection_id, i.customer_approved
         from service_requests sr
         join inspections i on i.service_request_id = sr.id
        where sr.id = $1 and sr.member_id = $2
        order by i.created_at desc
        limit 1`,
      [input.serviceRequestId, input.memberId],
    );
    if (rows.length === 0) return 'not_found';
    if (rows[0].customer_approved !== null) return 'already_answered';

    await tx.query(
      `update inspections
          set customer_approved = $2, customer_responded_at = now()
        where id = $1`,
      [rows[0].inspection_id, input.approved],
    );

    const nextStatus = input.approved ? 'approved' : 'returned_unserviced';
    await tx.query(
      `update service_requests set status = $2::service_status, updated_at = now() where id = $1`,
      [input.serviceRequestId, nextStatus],
    );
    await tx.query(
      `insert into events (service_request_id, kind, from_status, to_status, actor, payload)
       values ($1, 'customer_decision', $2::service_status, $3::service_status, 'customer', $4::jsonb)`,
      [input.serviceRequestId, rows[0].status, nextStatus, JSON.stringify({ approved: input.approved })],
    );

    return 'recorded';
  });
}
