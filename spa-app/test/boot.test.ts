import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The app must boot without a database.
 *
 * An eagerly-constructed pool once threw while the module graph was still
 * loading, which killed the entire server — every route, including the
 * diagnostic endpoint whose whole job is to say what is wrong. Shopify then
 * renders "There was an error in the third-party application", which names
 * nothing. These tests keep that from coming back.
 */

test('whoami answers without DATABASE_URL set', async () => {
  const savedDb = process.env.DATABASE_URL;
  const savedSecret = process.env.SHOPIFY_API_SECRET;
  delete process.env.DATABASE_URL;
  process.env.SHOPIFY_API_SECRET = 'boot-test-secret';

  try {
    const { loader } = await import('../app/routes/whoami.ts');
    const request = new Request('https://app.example.com/whoami?shop=s&signature=bad');
    const response = await loader({ request, params: {}, context: {} } as never);

    // A forged signature — but crucially it is an answer, not a crash. The
    // transport is 200 so Shopify does not swallow the body.
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'invalid_signature');
  } finally {
    if (savedDb !== undefined) process.env.DATABASE_URL = savedDb;
    if (savedSecret === undefined) delete process.env.SHOPIFY_API_SECRET;
    else process.env.SHOPIFY_API_SECRET = savedSecret;
  }
});

test('importing the database module without DATABASE_URL does not throw', async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const { default: pool } = await import('../app/db.server.ts');
    assert.equal(typeof pool.query, 'function', 'the module loads and exposes a pool');
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});

test('a query without DATABASE_URL fails with a sentence naming the variable', async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  // The lazy pool caches globally once built, so clear it or a previously
  // configured pool would answer here and hide the failure.
  const savedGlobal = (globalThis as { pgPoolGlobal?: unknown }).pgPoolGlobal;
  (globalThis as { pgPoolGlobal?: unknown }).pgPoolGlobal = undefined;
  try {
    const { default: pool } = await import('../app/db.server.ts');
    await assert.rejects(() => pool.query('select 1'), /DATABASE_URL is not set/);
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
    (globalThis as { pgPoolGlobal?: unknown }).pgPoolGlobal = savedGlobal;
  }
});
