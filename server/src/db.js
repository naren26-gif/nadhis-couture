// The only place that talks to PostgreSQL. All queries use $1, $2 ... placeholders (never string-built SQL).
import pg from 'pg';
import { dbUrl } from './config.js';

// numeric(12,2) money must stay exact, so pg's default (text) is kept: numbers arrive as strings like "450.00".
let pool;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: dbUrl(), max: 5, idleTimeoutMillis: 30000 });
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
