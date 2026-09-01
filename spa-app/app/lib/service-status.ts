/**
 * The service status ladder.
 *
 * Kept as an explicit graph rather than an ordered list because the flow
 * genuinely branches: inspection either proceeds straight to service or
 * detours through customer approval, and a customer who declines extra work
 * gets their unit back unserviced rather than falling off the end of the
 * process.
 *
 * Every transition is checked against this map before it is written, so a
 * unit cannot be marked shipped home while it is still sitting in the studio.
 *
 * These strings match the `service_status` enum in
 * supabase/migrations/0001_wig_spa_core.sql. If one side changes, the other
 * has to change with it.
 */
export const SERVICE_STATUSES = [
  'requested',
  'awaiting_shipment',
  'in_transit_to_studio',
  'received',
  'inspection',
  'awaiting_customer_approval',
  'approved',
  'in_service',
  'quality_check',
  'ready_to_ship',
  'return_shipment',
  'delivered',
  'completed',
  'cancelled',
  'returned_unserviced',
] as const;

export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

const TRANSITIONS: Record<ServiceStatus, readonly ServiceStatus[]> = {
  requested: ['awaiting_shipment', 'cancelled'],
  awaiting_shipment: ['in_transit_to_studio', 'cancelled'],
  in_transit_to_studio: ['received', 'cancelled'],
  received: ['inspection'],
  inspection: ['approved', 'awaiting_customer_approval', 'returned_unserviced'],
  awaiting_customer_approval: ['approved', 'returned_unserviced'],
  approved: ['in_service'],
  in_service: ['quality_check'],
  // Quality check can send a unit back to the bench — that is the point of it.
  quality_check: ['ready_to_ship', 'in_service'],
  ready_to_ship: ['return_shipment'],
  return_shipment: ['delivered'],
  delivered: ['completed'],
  returned_unserviced: ['return_shipment'],
  completed: [],
  cancelled: [],
};

/** Statuses where the unit is physically in the studio's hands. */
export const IN_STUDIO: ReadonlySet<ServiceStatus> = new Set<ServiceStatus>([
  'received',
  'inspection',
  'awaiting_customer_approval',
  'approved',
  'in_service',
  'quality_check',
  'ready_to_ship',
]);

/** Statuses that end the request's life. */
export const TERMINAL: ReadonlySet<ServiceStatus> = new Set<ServiceStatus>(['completed', 'cancelled']);

export function isServiceStatus(value: string): value is ServiceStatus {
  return (SERVICE_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: ServiceStatus, to: ServiceStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function nextStatuses(from: ServiceStatus): ServiceStatus[] {
  return [...TRANSITIONS[from]];
}

/**
 * Throws on an illegal move. Callers write the new status *and* an events row
 * inside one transaction, so a rejected transition leaves no trace.
 */
export function assertTransition(from: ServiceStatus, to: string): asserts to is ServiceStatus {
  if (!isServiceStatus(to)) {
    throw new Error(`Unknown service status: ${to}`);
  }
  if (from === to) {
    throw new Error(`Service request is already ${to}`);
  }
  if (!canTransition(from, to)) {
    throw new Error(`Cannot move a service request from ${from} to ${to}`);
  }
}

/**
 * When a membership allowance is spent.
 *
 * Not at request time: a customer can request a service and never post the
 * unit, and holding a service against them for that is how a membership earns
 * a chargeback. The allowance is consumed once the unit is physically in the
 * studio and the work is authorised.
 */
export function consumesAllowanceOn(status: ServiceStatus): boolean {
  return status === 'approved';
}
