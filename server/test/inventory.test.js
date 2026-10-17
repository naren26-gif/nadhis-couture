import { afterAll, describe, expect, it } from 'vitest';
import '../src/config.js';
import { query, closePool } from '../src/db.js';

afterAll(closePool);

describe('inventory_balance view', () => {
  it('can be read by the app role and gives whole-number stock per variant', async () => {
    const { rows } = await query('SELECT sku, on_hand FROM inventory_balance LIMIT 20');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.sku).toBe('string');
      expect(Number.isInteger(row.on_hand)).toBe(true);
    }
  });
});
