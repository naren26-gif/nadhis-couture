// The only place that talks to PostgreSQL. All queries use $1, $2 ... placeholders (never string-built SQL).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { dbUrl } from './config.js';
import { isConnectionProblem } from './errors.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// numeric(12,2) money must stay exact, so pg's default (text) is kept: numbers arrive as strings like "450.00".
let pool;

// Encrypted connection that is really checked. Supabase (and AWS RDS) use their own certificate authority, which
// Node does not know, so DB_CA_CERT_FILE points at that authority's public certificate file.
// We take over `sslmode` from the URL so the behaviour is explicit and the library warning goes away.
function connectionSettings() {
  const url = new URL(dbUrl());
  const mode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode');
  const settings = { connectionString: url.toString() };
  if (mode && mode !== 'disable') {
    const caFile = process.env.DB_CA_CERT_FILE;
    settings.ssl = caFile
      ? { ca: fs.readFileSync(path.resolve(projectRoot, caFile), 'utf8'), rejectUnauthorized: true }
      : { rejectUnauthorized: true };
  }
  return settings;
}

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({ ...connectionSettings(), max: 5, idleTimeoutMillis: 30000 });
    pool.on('error', (err) => console.error('Database connection problem:', err.code || err.message));
  }
  return pool;
}

// Run one query. `db` can be the pool (default) or a transaction client, so tests can pass a rolled-back client.
export async function query(text, params = [], db = getPool()) {
  return db.query(text, params);
}

// Getting a connection can fail for a moment (the hosted database's connection pooler occasionally refuses one).
// Nothing has been done yet at that point, so trying once more after a short pause is always safe.
async function connectWithOneRetry() {
  try {
    return await getPool().connect();
  } catch (err) {
    if (!isConnectionProblem(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return getPool().connect();
  }
}

// Run several statements as ONE all-or-nothing business action.
export async function withTransaction(work) {
  const client = await connectWithOneRetry();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Same all-or-nothing idea for a route. Normally that is a real transaction. In tests the whole request already runs
// inside one rolled-back transaction (req.db), so a SAVEPOINT is used instead.
export async function inTransaction(req, work) {
  if (!req.db) return withTransaction(work);
  await req.db.query('SAVEPOINT inner_work');
  try {
    const result = await work(req.db);
    await req.db.query('RELEASE SAVEPOINT inner_work');
    return result;
  } catch (err) {
    await req.db.query('ROLLBACK TO SAVEPOINT inner_work').catch(() => {});
    throw err;
  }
}

// Routes use the database of the current request. Normally that is the pool; tests put a transaction client
// on req.db so everything they write is rolled back (the app role cannot DELETE test rows afterwards).
export function getDb(req) {
  return req.db ?? getPool();
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
