import test from 'node:test';
import assert from 'node:assert/strict';
import { sendAlert } from '../app/lib/alerts.ts';

/**
 * The alert exists because the failure it reports is silent. These pin the two
 * properties that matter: it never takes down the webhook that raised it, and
 * when a notifier is configured the message actually leaves.
 */

const ORIGINAL_URL = process.env.ALERT_WEBHOOK_URL;
const ORIGINAL_FETCH = globalThis.fetch;

test.afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.ALERT_WEBHOOK_URL;
  else process.env.ALERT_WEBHOOK_URL = ORIGINAL_URL;
  globalThis.fetch = ORIGINAL_FETCH;
});

test('does nothing but log when no notifier is configured', async () => {
  delete process.env.ALERT_WEBHOOK_URL;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response('');
  }) as typeof fetch;

  await sendAlert({ event: 'app_uninstalled', summary: 'gone' });
  assert.equal(called, false, 'must not call out when unconfigured');
});

test('posts the summary where a chat notifier will render it', async () => {
  process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.test/abc';
  let seenUrl: string | undefined;
  let seenBody: any;
  globalThis.fetch = (async (url: any, init: any) => {
    seenUrl = String(url);
    seenBody = JSON.parse(init.body);
    return new Response('');
  }) as typeof fetch;

  await sendAlert({
    event: 'app_uninstalled',
    summary: 'The Wig Spa app was uninstalled',
    detail: { shop: 'example.myshopify.com' },
  });

  assert.equal(seenUrl, 'https://hooks.example.test/abc');
  // Slack and Discord both render `text`; everything else rides alongside.
  assert.equal(seenBody.text, 'The Wig Spa app was uninstalled');
  assert.equal(seenBody.event, 'app_uninstalled');
  assert.equal(seenBody.detail.shop, 'example.myshopify.com');
  assert.ok(seenBody.at, 'carries a timestamp');
});

test('a dead notifier does not fail the webhook that raised the alert', async () => {
  // Shopify retries deliveries it considers failed. If an unreachable notifier
  // could throw, one outage would become a retry storm.
  process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.test/abc';
  globalThis.fetch = (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as typeof fetch;

  await assert.doesNotReject(() => sendAlert({ event: 'app_uninstalled', summary: 'gone' }));
});
