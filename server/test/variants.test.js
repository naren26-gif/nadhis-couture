import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closePool } from '../src/db.js';
import { startTestApp } from './helpers.js';

let t;
let product; // a brand-new product made inside the test transaction
let fabric = 'Cotton';
let size = 'M';
let colour = 'Black';

beforeAll(async () => {
  t = await startTestApp();
  const res = await request(t.app).post('/api/products').send({ name: 'Zz Test Product' });
  expect(res.status).toBe(201);
  product = res.body;
});
afterAll(async () => {
  await t.stop();
  await closePool();
});

const newVariant = (overrides = {}) => ({
  product_id: product.id,
  fabric,
  size,
  colour,
  unit_cost: '290.10',
  list_price: '499.99',
  sku: 'ZZT-M-BLK',
  ...overrides,
});

describe('products and lookups', () => {
  it('rejects a duplicate product name, even with different capitals', async () => {
    const res = await request(t.app).post('/api/products').send({ name: 'zz test PRODUCT' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A product with that name already exists.');
  });

  it('adds a colour, tidies it, and refuses a duplicate', async () => {
    const ok = await request(t.app).post('/api/lookups/colours').send({ name: '  sea   green ' });
    expect(ok.status).toBe(201);
    expect(ok.body.name).toBe('Sea green');
    const dup = await request(t.app).post('/api/lookups/colours').send({ name: 'SEA GREEN' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('That colour already exists.');
  });

  it('adds a size at the end of the size order', async () => {
    const ok = await request(t.app).post('/api/lookups/sizes').send({ name: '5xl' });
    expect(ok.status).toBe(201);
    const lookups = await request(t.app).get('/api/lookups');
    expect(lookups.body.sizes.at(-1)).toBe('5XL');
    expect(lookups.body.sizes.slice(0, 3)).toEqual(['XS', 'S', 'M']);
  });
});

describe('variants', () => {
  it('creates a variant, then shows it in the list with an exact margin', async () => {
    const created = await request(t.app).post('/api/variants').send(newVariant());
    expect(created.status).toBe(201);
    expect(created.body.variant).toMatchObject({ sku: 'ZZT-M-BLK', unit_cost: '290.10', list_price: '499.99', margin: '209.89', on_hand: 0, is_active: true });

    const list = await request(t.app).get('/api/variants').query({ search: 'zzt-m' });
    expect(list.body.variants.map((v) => v.sku)).toEqual(['ZZT-M-BLK']);
  });

  it('rejects a duplicate SKU in plain English', async () => {
    const res = await request(t.app).post('/api/variants').send(newVariant({ size: 'L', sku: 'zzt-m-blk' }));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('That SKU is already used by another variant. Please change it.');
  });

  it('rejects the same fabric, size and colour twice for one product', async () => {
    const res = await request(t.app).post('/api/variants').send(newVariant({ sku: 'ZZT-M-BLK-2' }));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This product already has a variant with that fabric, size and colour.');
  });

  it('rejects negative or non-numeric money', async () => {
    const neg = await request(t.app).post('/api/variants').send(newVariant({ size: 'S', sku: 'ZZT-S-BLK', unit_cost: '-5' }));
    expect(neg.status).toBe(400);
    expect(neg.body.error).toContain('unit cost must be a number, 0 or more');
    const text = await request(t.app).post('/api/variants').send(newVariant({ size: 'S', sku: 'ZZT-S-BLK', list_price: 'abc' }));
    expect(text.status).toBe(400);
    expect(text.body.error).toContain('list price must be a number');
  });

  it('the transaction still works after those failed requests', async () => {
    const res = await request(t.app).post('/api/variants').send(newVariant({ size: 'S', sku: 'ZZT-S-BLK' }));
    expect(res.status).toBe(201);
  });

  it('edits prices but cannot change the SKU', async () => {
    const list = await request(t.app).get('/api/variants').query({ search: 'ZZT-S-BLK' });
    const { variant_id } = list.body.variants[0];
    const res = await request(t.app).patch(`/api/variants/${variant_id}`).send({ unit_cost: '300', list_price: '600', sku: 'HACKED' });
    expect(res.status).toBe(200);
    expect(res.body.variant).toMatchObject({ sku: 'ZZT-S-BLK', unit_cost: '300.00', list_price: '600.00', margin: '300.00' });
  });

  it('suggests a SKU that is not taken', async () => {
    const res = await request(t.app).get('/api/variants/suggest-sku').query({ product_id: product.id, fabric, size: 'M', colour });
    expect(res.status).toBe(200);
    expect(res.body.sku).not.toBe('ZZT-M-BLK');
    expect(res.body.sku).toMatch(/^ZZT?[A-Z]*-M-BLK-?2?$|^[A-Z]+-M-BLK/);
  });

  it('stock filter agrees with inventory_balance', async () => {
    const inStock = await request(t.app).get('/api/variants').query({ stock: 'in' });
    const outStock = await request(t.app).get('/api/variants').query({ stock: 'out' });
    expect(inStock.body.variants.every((v) => v.on_hand > 0)).toBe(true);
    expect(outStock.body.variants.every((v) => v.on_hand <= 0)).toBe(true);
    const all = await request(t.app).get('/api/variants');
    expect(inStock.body.variants.length + outStock.body.variants.length).toBe(all.body.variants.length);
  });

  it('staff cannot deactivate; the owner can, and the row is kept (hidden by default)', async () => {
    const list = await request(t.app).get('/api/variants').query({ search: 'ZZT-M-BLK' });
    const { variant_id } = list.body.variants[0];

    const staff = await request(t.app).post(`/api/variants/${variant_id}/deactivate`).set('x-test-role', 'staff');
    expect(staff.status).toBe(403);
    expect(staff.body.error).toBe('Only the owner can do that.');

    const owner = await request(t.app).post(`/api/variants/${variant_id}/deactivate`);
    expect(owner.status).toBe(200);
    expect(owner.body.variant.is_active).toBe(false);

    const hidden = await request(t.app).get('/api/variants').query({ search: 'ZZT-M-BLK' });
    expect(hidden.body.variants).toHaveLength(0);
    const shown = await request(t.app).get('/api/variants').query({ search: 'ZZT-M-BLK', inactive: 'true' });
    expect(shown.body.variants).toHaveLength(1);

    const back = await request(t.app).post(`/api/variants/${variant_id}/activate`);
    expect(back.body.variant.is_active).toBe(true);
  });
});
