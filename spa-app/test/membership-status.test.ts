import test from 'node:test';
import assert from 'node:assert/strict';
import { membershipStatusFromContract } from '../app/lib/db.ts';

/**
 * The mapping from Shopify's contract status onto ours.
 *
 * This is small enough to look obviously right and consequential enough to be
 * worth pinning: it decides whether a member keeps their included services.
 */

test('an active contract is an active membership', () => {
  assert.equal(membershipStatusFromContract('ACTIVE'), 'active');
});

test('a failed charge is past_due, not cancelled', () => {
  // Shopify retries a failed payment. Reading FAILED as cancelled would strip
  // a paying member's benefits over a card that expired on a Tuesday.
  assert.equal(membershipStatusFromContract('FAILED'), 'past_due');
});

test('paused, cancelled and expired carry across', () => {
  assert.equal(membershipStatusFromContract('PAUSED'), 'paused');
  assert.equal(membershipStatusFromContract('CANCELLED'), 'cancelled');
  assert.equal(membershipStatusFromContract('EXPIRED'), 'expired');
});

test('American spelling of cancelled is understood', () => {
  assert.equal(membershipStatusFromContract('CANCELED'), 'cancelled');
});

test('status is read case-insensitively', () => {
  assert.equal(membershipStatusFromContract('active'), 'active');
  assert.equal(membershipStatusFromContract('Paused'), 'paused');
});

test('an unknown status never reads as active', () => {
  // The failure direction matters. Guessing "active" for a status we do not
  // recognise gives away free reconstructions; guessing past_due does not.
  for (const unknown of ['SOMETHING_NEW', '', 'stale']) {
    assert.notEqual(membershipStatusFromContract(unknown), 'active');
    assert.equal(membershipStatusFromContract(unknown), 'past_due');
  }
});
