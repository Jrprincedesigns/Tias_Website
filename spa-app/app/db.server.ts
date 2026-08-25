import pg from 'pg';

/**
 * The Postgres pool, shared across requests.
 *
 * Supabase is the only database this app talks to. Session storage lives here
 * alongside the service tables rather than in a second store, so there is one
 * database to back up and one connection string to rotate.
 *
 * In development the module is re-evaluated on every hot reload, which would
 * otherwise open a new pool each time until Postgres refuses connections. The
 * global holds it across reloads.
 */

declare global {
  // eslint-disable-next-line no-var
  var pgPoolGlobal: pg.Pool | undefined;
}

function createPool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — the app cannot reach Supabase');
  }
  return new pg.Pool({
    connectionString,
    // Serverless functions are short-lived and numerous; a large pool per
    // instance exhausts Postgres connections quickly. Supabase's pooler is
    // what actually multiplexes, so keep this small.
    max: Number(process.env.DATABASE_POOL_MAX ?? 3),
  });
}

const pool = global.pgPoolGlobal ?? createPool();
if (process.env.NODE_ENV !== 'production') global.pgPoolGlobal = pool;

export default pool;
