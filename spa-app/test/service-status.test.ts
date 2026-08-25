import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVICE_STATUSES,
  type ServiceStatus,
  canTransition,
  nextStatuses,
  assertTransition,
  consumesAllowanceOn,
  IN_STUDIO,
  TERMINAL,
} from '../app/lib/service-status.ts';

test('the happy path walks end to end', () => {
  const path: ServiceStatus[] = [
    'requested', 'awaiting_shipment', 'in_transit_to_studio', 'received',
    'inspection', 'approved', 'in_service', 'quality_check', 'ready_to_ship',
    'return_shipment', 'delivered', 'completed',
  ];
  for (let i = 0; i < path.length - 1; i += 1) {
    const from = path[i]!;
    const to = path[i + 1]!;
    assert.ok(canTransition(from, to), `${from} -> ${to} should be allowed`);
  }
});

test('the approval detour reaches service', () => {
  assert.ok(canTransition('inspection', 'awaiting_customer_approval'));
  assert.ok(canTransition('awaiting_customer_approval', 'approved'));
});

test('a customer declining extra work gets the unit back', () => {
  assert.ok(canTransition('awaiting_customer_approval', 'returned_unserviced'));
  assert.ok(canTransition('returned_unserviced', 'return_shipment'));
});

test('quality check can send a unit back to the bench', () => {
  assert.ok(canTransition('quality_check', 'in_service'));
});

test('a unit cannot ship home while it is still in the studio', () => {
  assert.throws(() => assertTransition('in_service', 'return_shipment'), /Cannot move/);
  assert.throws(() => assertTransition('received', 'completed'), /Cannot move/);
});

test('work cannot begin before the unit arrives', () => {
  assert.throws(() => assertTransition('awaiting_shipment', 'in_service'), /Cannot move/);
});

test('inspection cannot be skipped', () => {
  assert.throws(() => assertTransition('received', 'approved'), /Cannot move/);
});

test('terminal states are terminal', () => {
  for (const status of TERMINAL) {
    assert.deepEqual(nextStatuses(status), [], `${status} should have no exits`);
  }
});

test('a request cannot be cancelled once the unit is in our hands', () => {
  for (const status of IN_STUDIO) {
    assert.ok(!canTransition(status, 'cancelled'), `${status} should not cancel outright`);
  }
});

test('re-applying the current status is rejected, not silently accepted', () => {
  assert.throws(() => assertTransition('in_service', 'in_service'), /already in_service/);
});

test('an unknown status is rejected', () => {
  assert.throws(() => assertTransition('received', 'shipped_to_mars'), /Unknown service status/);
});

test('every status is reachable from requested', () => {
  const seen = new Set<ServiceStatus>(['requested']);
  const queue: ServiceStatus[] = ['requested'];
  while (queue.length) {
    for (const next of nextStatuses(queue.pop()!)) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  const unreachable = SERVICE_STATUSES.filter((s) => !seen.has(s));
  assert.deepEqual(unreachable, [], `unreachable statuses: ${unreachable.join(', ')}`);
});

test('every non-terminal status can still reach completed or cancelled', () => {
  const stuck = SERVICE_STATUSES.filter((start) => {
    const seen = new Set<ServiceStatus>([start]);
    const queue: ServiceStatus[] = [start];
    while (queue.length) {
      for (const next of nextStatuses(queue.pop()!)) {
        if (TERMINAL.has(next)) return false;
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    return !TERMINAL.has(start);
  });
  assert.deepEqual(stuck, [], `statuses with no way to finish: ${stuck.join(', ')}`);
});

test('allowance is spent on approval, not on request', () => {
  assert.equal(consumesAllowanceOn('approved'), true);
  assert.equal(consumesAllowanceOn('requested'), false);
  assert.equal(consumesAllowanceOn('awaiting_shipment'), false);
});
