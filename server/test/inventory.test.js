import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { query, closePool } from '../src/db.js';
import { startTestApp } from './helpers.js';

let t;
let variantId; // a brand-new variant made inside the test transaction, starting with 0 in stock

beforeAll(async () => {
  t = await startTestApp();
  const product = await request(t.app).post('/api/products').send({ name: 'Zz Stock Test Product' });
  expect(product.status).toBe(201);
  const variant = await request(t.app).post('/api/variants').send({
    product_id: product.body.id,
    fabric: 'Cotton',
    size: 'M',
    colour: 'Black',
    unit_cost: '100.00',
    list_price: '200.00',
    sku: 'ZZS-M-BLK',
  });
  expect(variant.status).toBe(201);
  variantId = variant.body.variant.variant_id;
});
afterAll(async () => {
  await t.stop();
  await closePool();
});

const adjust = (body) => request(t.app).post('/api/inventory/adjustments').send({ variant_id: variantId, ...body });
const find = async () => {
  const res = await request(t.app).get('/api/inventory').query({ search: 'ZZS-M-BLK' });
  return res.body.variants[0];
};

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

describe('stock list', () => {
  it('lists variants with totals, and the stock filter works', async () => {
    const all = await request(t.app).get('/api/inventory');
    expect(all.status).toBe(200);
    expect(all.body.variants.length).toBeGreaterThan(1);
    expect(Number.isInteger(all.body.totals.pieces)).toBe(true);
    expect(all.body.totals.value).toMatch(/^\d+\.\d{2}$/);

    const out = await request(t.app).get('/api/inventory').query({ stock: 'out', search: 'ZZS-M-BLK' });
    expect(out.body.variants.map((v) => v.sku)).toEqual(['ZZS-M-BLK']);
    const inStock = await request(t.app).get('/api/inventory').query({ stock: 'in', search: 'ZZS-M-BLK' });
    expect(inStock.body.variants).toEqual([]);
  });
});

describe('stock adjustments', () => {
  it('adds stock, records reason and user, and shows it newest first in the history', async () => {
    const first = await adjust({ direction: 'add', quantity: 5, reason: 'Stock count correction' });
    expect(first.status).toBe(201);
    expect(first.body.on_hand).toBe(5);
    const second = await adjust({ direction: 'remove', quantity: 2, reason: 'Damaged in storage' });
    expect(second.status).toBe(201);
    expect(second.body.on_hand).toBe(3);

    expect((await find()).on_hand).toBe(3);
    expect((await find()).stock_value).toBe('300.00');

    const history = await request(t.app).get(`/api/inventory/${variantId}/movements`);
    expect(history.status).toBe(200);
    expect(history.body.movements.map((m) => m.quantity)).toEqual([-2, 5]);
    expect(history.body.movements[0]).toMatchObject({
      movement_type: 'Adjustment',
      reason: 'Damaged in storage',
      created_by: 'Test',
    });
  });

  it('refuses to remove more than is in stock, and changes nothing', async () => {
    const before = (await find()).on_hand;
    const res = await adjust({ direction: 'remove', quantity: before + 1, reason: 'Too many' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Not enough stock: only ${before} left`);
    expect((await find()).on_hand).toBe(before);
  });

  it('needs a real reason and a whole-number quantity of 1 or more', async () => {
    const noReason = await adjust({ direction: 'add', quantity: 1, reason: '   ' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toMatch(/reason/i);

    for (const quantity of [0, -3, 1.5]) {
      const res = await adjust({ direction: 'add', quantity, reason: 'Testing' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('The quantity must be a whole number, 1 or more.');
    }
  });

  it('answers 404 for an unknown variant', async () => {
    const res = await request(t.app)
      .post('/api/inventory/adjustments')
      .send({ variant_id: '11111111-1111-4111-8111-111111111111', direction: 'add', quantity: 1, reason: 'Testing' });
    expect(res.status).toBe(404);
  });

  it('refuses to change a hidden variant', async () => {
    await request(t.app).post(`/api/variants/${variantId}/deactivate`);
    const res = await adjust({ direction: 'add', quantity: 1, reason: 'Testing' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hidden/);
    await request(t.app).post(`/api/variants/${variantId}/activate`);
  });

  it('offers no way to edit or delete a movement', async () => {
    const history = await request(t.app).get(`/api/inventory/${variantId}/movements`);
    const movementId = history.body.movements[0].movement_id;
    for (const method of ['patch', 'put', 'delete']) {
      const res = await request(t.app)[method](`/api/inventory/${movementId}`);
      expect(res.status).toBe(404);
    }
  });
});
