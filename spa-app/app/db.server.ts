import pg from 'pg';

/**
 * The Postgres pool, created on first use rather than at import.
 *
 * Laziness is deliberate. Building the pool at module load meant a missing
 * DATABASE_URL took the whole server down before it could serve anything —
 * including the diagnostic endpoint whose job is to tell you what is wrong.
 * A route that needs the database should fail; a route that doesn't should
 * still answer.
 *
 * In development the module is re-evaluated on every hot reload, which would
 * otherwise open a fresh pool each time until Postgres refuses connections.
 * The global holds it across reloads.
 */

declare global {
  // eslint-disable-next-line no-var
  var pgPoolGlobal: pg.Pool | undefined;
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set — this endpoint needs Supabase. Use the pooler connection string (port 6543).',
    );
  }
  return url;
}

function createPool(): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl(),
    // Serverless functions are short-lived and numerous; a large pool per
    // instance exhausts Postgres connections quickly. Supabase's pooler is
    // what actually multiplexes, so keep this small.
    max: Number(process.env.DATABASE_POOL_MAX ?? 3),
  });
}

function getPool(): pg.Pool {
  const existing = global.pgPoolGlobal;
  if (existing) return existing;

  const created = createPool();
  if (process.env.NODE_ENV !== 'production') global.pgPoolGlobal = created;
  return created;
}

/**
 * Implements the Queryable/Transactable shape used by app/lib/db.ts, deferring
 * the real pool until a query is actually issued.
 */
const pool = {
  // Both of these return rejected promises rather than throwing synchronously.
  // pg's own API is promise-based, and a sync throw from a function callers
  // treat as async slips straight past `.catch()` and becomes an unhandled
  // exception instead of a handled failure.
  query(text: string, values?: unknown[]) {
    try {
      return getPool().query(text, values as never);
    } catch (error) {
      return Promise.reject(error);
    }
  },
  connect() {
    try {
      return getPool().connect();
    } catch (error) {
      return Promise.reject(error);
    }
  },
  end() {
    const existing = global.pgPoolGlobal;
    global.pgPoolGlobal = undefined;
    return existing ? existing.end() : Promise.resolve();
  },
};

export default pool;
