import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQueue,
  isStale,
  waitingFor,
  staleAfterDays,
  DEFAULT_STALE_AFTER_DAYS,
} from '../app/lib/work-queue.ts';
import type { ServiceRequestSummary } from '../app/lib/db.ts';
import type { ServiceStatus } from '../app/lib/service-status.ts';

const NOW = new Date('2026-08-25T12:00:00Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

function item(status: ServiceStatus, sinceDays: number, nickname = 'Unit'): ServiceRequestSummary {
  return {
    id: `${status}-${sinceDays}`,
    wigId: 'wig',
    wigNickname: nickname,
    serviceType: 'rejuvenation',
    status,
    coveredByAllowance: true,
    submittedAt: daysAgo(sinceDays + 2),
    statusSince: daysAgo(sinceDays),
  };
}

test('empty studio produces no buckets', () => {
  const queue = buildQueue([], NOW, 7);
  assert.deepEqual(queue.buckets, []);
  assert.equal(queue.totalOpen, 0);
});

test('buckets with nothing in them are not shown', () => {
  const queue = buildQueue([item('received', 1)], NOW, 7);
  assert.equal(queue.buckets.length, 1);
  assert.equal(queue.buckets[0]?.key, 'inspect');
});

test('customer approval outranks everything else', () => {
  // Ordering is the whole point of the screen: a customer waiting on an answer
  // is the thing most likely to rot.
  const queue = buildQueue(
    [item('in_service', 1), item('awaiting_customer_approval', 1), item('ready_to_ship', 1)],
    NOW,
    7,
  );
  assert.equal(queue.buckets[0]?.key, 'approval');
});

test('inside a bucket, the longest-ignored comes first', () => {
  const queue = buildQueue(
    [item('received', 1, 'Newer'), item('received', 9, 'Older'), item('received', 4, 'Middle')],
    NOW,
    7,
  );
  assert.deepEqual(
    queue.buckets[0]?.items.map((i) => i.wigNickname),
    ['Older', 'Middle', 'Newer'],
  );
});

test('staleness counts from the last move, not from submission', () => {
  // A wig submitted in January that moved yesterday is fine. Measuring from
  // submission would flag every long-running job forever.
  const moved = item('in_service', 1);
  moved.submittedAt = daysAgo(90);
  assert.equal(isStale(moved, NOW, 7), false);
});

test('a unit sitting past the threshold is stale', () => {
  assert.equal(isStale(item('received', 8), NOW, 7), true);
  assert.equal(isStale(item('received', 7), NOW, 7), true, 'exactly at the threshold counts');
  assert.equal(isStale(item('received', 6.9), NOW, 7), false);
});

test('stale counts roll up across buckets', () => {
  const queue = buildQueue(
    [item('received', 10), item('in_service', 9), item('ready_to_ship', 1)],
    NOW,
    7,
  );
  assert.equal(queue.totalStale, 2);
  assert.equal(queue.totalOpen, 3);
});

test('transit and unsent work are marked as someone else’s move', () => {
  const queue = buildQueue([item('in_transit_to_studio', 1), item('requested', 1)], NOW, 7);
  for (const bucket of queue.buckets) {
    assert.equal(bucket.waitingOnOthers, true, `${bucket.key} is not Tia's move`);
  }
});

test('bench work is Tia’s move', () => {
  const queue = buildQueue([item('in_service', 1)], NOW, 7);
  assert.equal(queue.buckets[0]?.waitingOnOthers, false);
});

test('completed and cancelled never appear', () => {
  // They are filtered in SQL, but if one leaks through it must not land in a
  // bucket and read as live work.
  const queue = buildQueue([item('completed', 1), item('cancelled', 1)], NOW, 7);
  assert.deepEqual(queue.buckets, []);
});

test('waiting reads like a person wrote it', () => {
  assert.equal(waitingFor(item('received', 0.2), NOW), 'today');
  assert.equal(waitingFor(item('received', 1), NOW), '1 day');
  assert.equal(waitingFor(item('received', 5), NOW), '5 days');
});

test('the threshold is configurable and falls back sanely', () => {
  assert.equal(staleAfterDays({ WIG_SPA_STALE_AFTER_DAYS: '3' }), 3);
  assert.equal(staleAfterDays({}), DEFAULT_STALE_AFTER_DAYS);
  assert.equal(staleAfterDays({ WIG_SPA_STALE_AFTER_DAYS: 'soon' }), DEFAULT_STALE_AFTER_DAYS);
  assert.equal(staleAfterDays({ WIG_SPA_STALE_AFTER_DAYS: '0' }), DEFAULT_STALE_AFTER_DAYS);
  assert.equal(staleAfterDays({ WIG_SPA_STALE_AFTER_DAYS: '-2' }), DEFAULT_STALE_AFTER_DAYS);
});
