import { afterAll, describe, expect, it, vi } from 'vitest';
import '../src/config.js';
import { closePool, withTransaction } from '../src/db.js';

afterAll(closePool);

describe('withTransaction', () => {
  it('survives a connection error between two statements instead of crashing the server', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A dropped connection shows up as an 'error' event on the checked-out client. Without a listener Node throws
    // "Unhandled error event" and, in the real server, the whole process exits.
    const result = await withTransaction(async (client) => {
      client.emit('error', Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' }));
      const { rows } = await client.query('SELECT 1 AS ok');
      return rows[0].ok;
    });
    expect(result).toBe(1);
    expect(log.mock.calls.flat().join(' ')).toContain('Database connection problem during a transaction');
  });

  it('commits on success and rolls back on failure, as before', async () => {
    const ok = await withTransaction(async (client) => (await client.query('SELECT 42 AS n')).rows[0].n);
    expect(ok).toBe(42);
    await expect(withTransaction(async () => { throw new Error('nope'); })).rejects.toThrow('nope');
  });
});
