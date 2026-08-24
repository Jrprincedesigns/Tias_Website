import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  verifyProxySignature,
  customerFromProxyRequest,
  verifyWebhookHmac,
} from '../app/lib/shopify-auth.js';

const SECRET = 'shpss_test_secret';

/** Build a correctly-signed proxy query the way Shopify does. */
function signedQuery(params) {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${Array.isArray(params[k]) ? params[k].join(',') : params[k]}`)
    .join('');
  const signature = crypto.createHmac('sha256', SECRET).update(message, 'utf8').digest('hex');
  const search = new URLSearchParams(params);
  search.set('signature', signature);
  return search;
}

test('accepts a genuine Shopify proxy signature', () => {
  const q = signedQuery({ shop: 'theetcollection.myshopify.com', path_prefix: '/apps/spa', timestamp: '1700000000' });
  assert.equal(verifyProxySignature(q, SECRET), true);
});

test('rejects a tampered parameter', () => {
  const q = signedQuery({ shop: 'theetcollection.myshopify.com', logged_in_customer_id: '1' });
  q.set('logged_in_customer_id', '2'); // impersonation attempt
  assert.equal(verifyProxySignature(q, SECRET), false);
});

test('rejects a missing signature', () => {
  assert.equal(verifyProxySignature(new URLSearchParams({ shop: 'x' }), SECRET), false);
});

test('rejects a signature made with the wrong secret', () => {
  const q = signedQuery({ shop: 'x' });
  assert.equal(verifyProxySignature(q, 'not_the_secret'), false);
});

test('rejects a truncated signature without throwing', () => {
  const q = signedQuery({ shop: 'x' });
  q.set('signature', q.get('signature').slice(0, 10));
  assert.equal(verifyProxySignature(q, SECRET), false);
});

test('handles repeated parameters the way Shopify joins them', () => {
  const q = signedQuery({ ids: ['1', '2', '3'], shop: 'x' });
  assert.equal(verifyProxySignature(q, SECRET), true);
});

test('returns the logged-in customer as a GID', () => {
  const q = signedQuery({ shop: 'x', logged_in_customer_id: '7401' });
  const customer = customerFromProxyRequest(`https://app.example.com/proxy/closet?${q}`, SECRET);
  assert.deepEqual(customer, { shopifyCustomerId: 'gid://shopify/Customer/7401' });
});

test('returns null for a logged-out visitor rather than throwing', () => {
  const q = signedQuery({ shop: 'x' });
  assert.equal(customerFromProxyRequest(`https://app.example.com/proxy/closet?${q}`, SECRET), null);
});

test('throws when the signature is forged', () => {
  const url = 'https://app.example.com/proxy/closet?shop=x&logged_in_customer_id=9&signature=deadbeef';
  assert.throws(() => customerFromProxyRequest(url, SECRET), /Invalid app proxy signature/);
});

test('accepts a genuine webhook hmac', () => {
  const body = JSON.stringify({ id: 1, admin_graphql_api_id: 'gid://shopify/SubscriptionContract/1' });
  const hmac = crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('base64');
  assert.equal(verifyWebhookHmac(body, hmac, SECRET), true);
});

test('rejects a webhook whose body was altered in flight', () => {
  const body = JSON.stringify({ id: 1 });
  const hmac = crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('base64');
  assert.equal(verifyWebhookHmac(JSON.stringify({ id: 2 }), hmac, SECRET), false);
});

test('rejects a webhook with no hmac header', () => {
  assert.equal(verifyWebhookHmac('{}', undefined, SECRET), false);
});

test('rejects a re-serialised body (whitespace lost)', () => {
  // Guards the "parse then re-stringify" mistake. Shopify sends bytes, not
  // objects, and a body that survives a JSON round-trip semantically can
  // still hash differently — here the spaces are dropped.
  const raw = '{"a": 1, "b": 2}';
  const hmac = crypto.createHmac('sha256', SECRET).update(raw, 'utf8').digest('base64');
  assert.equal(verifyWebhookHmac(JSON.stringify(JSON.parse(raw)), hmac, SECRET), false);
});
