// The only place that talks to PostgreSQL. All queries use $1, $2 ... placeholders (never string-built SQL).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { dbUrl } from './config.js';

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

// Run several statements as ONE all-or-nothing business action.
export async function withTransaction(work) {
  const client = await getPool().connect();
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

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
