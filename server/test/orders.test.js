import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closePool, query } from '../src/db.js';
import { startTestApp } from './helpers.js';

let t;
let customerId;
let variantA; // list 500.00, cost 200.00
let variantB; // list 499.99, cost 290.10
let method;
let courierId;

const api = () => request(t.app);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const sql = (text, params = []) => query(text, params, t.client);

beforeAll(async () => {
  t = await startTestApp();
  const customer = await api().post('/api/customers').send({ name: 'Zz Order Customer', phone: '+91 90000 88888' });
  customerId = customer.body.item.id;
  const product = await api().post('/api/products').send({ name: 'Zz Order Product' });
  const make = async (sku, size, cost, price) => {
    const res = await api().post('/api/variants').send({
      product_id: product.body.id, fabric: 'Cotton', size, colour: 'Black', unit_cost: cost, list_price: price, sku,
    });
    expect(res.status).toBe(201);
    return res.body.variant;
  };
  variantA = await make('ZZO-M-BLK', 'M', '200.00', '500.00');
  variantB = await make('ZZO-L-BLK', 'L', '290.10', '499.99');
  method = (await api().get('/api/orders/lookups')).body.methods[0];
  courierId = (await sql("SELECT supplier_id FROM supplier WHERE supplier_code = 'SPLR0004'")).rows[0].supplier_id;
});
afterAll(async () => {
  await t.stop();
  await closePool();
});

const newOrder = (overrides = {}) =>
  api().post('/api/orders').send({
    customer_id: customerId,
    order_date: today(),
    lines: [
      { variant_id: variantA.variant_id, quantity: 3 },
      { variant_id: variantB.variant_id, quantity: 3, unit_price: '499.99', discount: '50.00' },
    ],
    ...overrides,
  });
const addStock = (variant, quantity) =>
  api().post('/api/inventory/adjustments').send({ variant_id: variant.variant_id, direction: 'add', quantity, reason: 'Test stock' });
const ship = (order, lines) =>
  // always pass the India date: the database's own CURRENT_DATE is UTC and is "yesterday" for the first hours of the day
  sql('SELECT ship_items($1::jsonb, $2, $3::date, 0, NULL, $4, 0)', [
    JSON.stringify(lines.map(([i, quantity]) => ({ order_item_id: order.lines[i].item_id, quantity }))), courierId, today(), 'Test',
  ]);
const edit = (order, body) =>
  api().patch(`/api/orders/${order.id}`).send({ customer_id: customerId, order_date: order.order_date, notes: null, ...body });
const asLines = (order, change = {}) =>
  order.lines.map((l, i) => ({ item_id: l.item_id, variant_id: l.variant_id, quantity: l.quantity, unit_price: l.unit_price, discount: l.discount, ...(change[i] ?? {}) }));

describe('creating orders', () => {
  it('computes totals exactly, defaults price from the list price, and gives an SO_ code', async () => {
    const res = await newOrder();
    expect(res.status).toBe(201);
    const o = res.body.order;
    expect(o.code).toMatch(/^SO_\d{7}$/);
    expect(o.lines.map((l) => [l.sku, l.quantity, l.unit_price, l.discount, l.line_total])).toEqual([
      ['ZZO-M-BLK', 3, '500.00', '0.00', '1500.00'], // price came from the list price
      ['ZZO-L-BLK', 3, '499.99', '50.00', '1449.97'],
    ]);
    expect(o).toMatchObject({
      items_total: '2949.97', shipping_charged: '0.00', order_total: '2949.97', received: '0.00', balance: '2949.97',
      payment_state: 'Unpaid', status: 'Pending', product_cost: '1470.30', profit: '1479.67', editable: true,
    });
  });

  it('numbers orders last + 1 with no gaps, even after a refused save', async () => {
    const first = (await newOrder()).body.order;
    expect((await newOrder({ lines: [] })).status).toBe(400);
    const second = (await newOrder()).body.order;
    expect(Number(second.code.slice(3))).toBe(Number(first.code.slice(3)) + 1);
  });

  it('always takes the cost from the product master, whatever the browser sends', async () => {
    const res = await newOrder({
      lines: [{ variant_id: variantA.variant_id, quantity: 1, unit_cost: '1.00', unit_cost_snapshot: '1.00' }],
    });
    expect(res.body.order.lines[0].unit_cost_snapshot).toBe('200.00');
  });

  it('allows a walk-in customer, and ordering more than is in stock without moving any stock', async () => {
    const res = await newOrder({ customer_id: undefined });
    expect(res.status).toBe(201);
    expect(res.body.order.customer_name).toBeNull();
    expect(res.body.order.waiting_for_stock).toBe(true); // nothing in stock yet
    const stock = await api().get('/api/inventory').query({ search: 'ZZO-M-BLK' });
    expect(stock.body.variants[0].on_hand).toBe(0);
  });

  it('explains bad input in plain English', async () => {
    expect((await newOrder({ lines: [] })).body.error).toBe('Please add at least one product line.');
    expect((await newOrder({ order_date: '2999-01-01' })).body.error).toBe('The order date cannot be in the future.');
    const dup = await newOrder({ lines: [{ variant_id: variantA.variant_id, quantity: 1 }, { variant_id: variantA.variant_id, quantity: 1 }] });
    expect(dup.body.error).toMatch(/two lines/);
    const big = await newOrder({ lines: [{ variant_id: variantA.variant_id, quantity: 1, discount: '500.01' }] });
    expect(big.body.error).toBe("ZZO-M-BLK: the discount can't be more than the line total of ₹500.00.");
    const qty = await newOrder({ lines: [{ variant_id: variantA.variant_id, quantity: 0 }] });
    expect(qty.body.error).toBe('The quantity must be a whole number, 1 or more.');

    await api().post(`/api/variants/${variantB.variant_id}/deactivate`);
    const hidden = await newOrder();
    expect(hidden.body.error).toMatch(/ZZO-L-BLK is hidden/);
    await api().post(`/api/variants/${variantB.variant_id}/activate`);
  });
});

describe('editing orders', () => {
  it('recalculates totals, keeps old cost snapshots, and lets an unshipped line be removed', async () => {
    const o = (await newOrder()).body.order;
    await api().patch(`/api/variants/${variantA.variant_id}`).send({ unit_cost: '250.00', list_price: '500.00' }); // master cost changes later

    const changed = await edit(o, { lines: asLines(o, { 0: { quantity: 4 } }), notes: 'Corrected' });
    expect(changed.status).toBe(200);
    expect(changed.body.order.items_total).toBe('3449.97'); // 4 x 500 + 1449.97
    expect(changed.body.order.lines[0].unit_cost_snapshot).toBe('200.00'); // unchanged line keeps its snapshot

    const removed = await edit(o, { lines: asLines(o).slice(0, 1) }); // drop line B
    expect(removed.status).toBe(200);
    expect(removed.body.order.lines.map((l) => l.sku)).toEqual(['ZZO-M-BLK']);
    expect(removed.body.order.items_total).toBe('1500.00');

    const none = await edit(o, { lines: [] });
    expect(none.body.error).toBe('Please add at least one product line.');

    // a newly added line takes the CURRENT master cost
    const added = await edit(o, { lines: [...asLines(o).slice(0, 1), { variant_id: variantB.variant_id, quantity: 1 }] });
    const lineB = added.body.order.lines.find((l) => l.sku === 'ZZO-L-BLK');
    expect(lineB).toMatchObject({ unit_price: '499.99', unit_cost_snapshot: '290.10' });
  });

  it('locks a shipped line, and flips the order to Shipped when nothing else is left to ship', async () => {
    await addStock(variantA, 10);
    const o = (await newOrder()).body.order; // A x3, B x3
    await ship(o, [[0, 2]]); // ship 2 of line A
    const now = (await api().get(`/api/orders/${o.id}`)).body.order;
    expect(now.status).toBe('Partially Shipped');
    expect(now.lines[0]).toMatchObject({ shipped: 2, remaining: 1 });
    expect(now.editable).toBe(true);

    const price = await edit(now, { lines: asLines(now, { 0: { unit_price: '450.00' } }) });
    expect(price.body.error).toBe("ZZO-M-BLK has already shipped, so its product, price and discount can't change.");
    const lower = await edit(now, { lines: asLines(now, { 0: { quantity: 1 } }) });
    expect(lower.body.error).toBe("ZZO-M-BLK: 2 already shipped, so the quantity can't be lower than that.");
    const removeShipped = await edit(now, { lines: asLines(now).slice(1) });
    expect(removeShipped.body.error).toBe("ZZO-M-BLK has already shipped, so it can't be removed.");

    // drop the unshipped line B and reduce A to what shipped: nothing left to ship, so the order is now Shipped
    const done = await edit(now, { lines: asLines(now, { 0: { quantity: 2 } }).slice(0, 1) });
    expect(done.status).toBe(200);
    expect(done.body.order.status).toBe('Shipped');
    expect(done.body.order.editable).toBe(false);
    expect(done.body.order.parcels).toHaveLength(1);

    const again = await edit(done.body.order, { lines: asLines(done.body.order) });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("This order is already shipped, so it can't be edited.");
  });
});

describe('payments from the customer', () => {
  it('moves Unpaid -> Partial -> Paid, and matches the database view', async () => {
    const o = (await newOrder()).body.order; // 2949.97
    const pay = (body) => api().post(`/api/orders/${o.id}/payments`).send({ amount: '1000', txn_date: today(), payment_method: method, ...body });

    const first = await pay({});
    expect(first.status).toBe(201);
    expect(first.body.order).toMatchObject({ received: '1000.00', balance: '1949.97', payment_state: 'Partial' });
    const last = await pay({ amount: '1949.97' });
    expect(last.body.order).toMatchObject({ received: '2949.97', balance: '0.00', payment_state: 'Paid' });
    const [a, b] = last.body.order.payments.map((p) => Number(p.code.slice(5)));
    expect(b).toBe(a + 1);

    const view = await sql('SELECT received, balance, payment_state FROM order_summary WHERE order_id = $1', [o.id]);
    expect(view.rows[0]).toMatchObject({ received: '2949.97', balance: '0.00', payment_state: 'Paid' });
  });

  it('needs confirmation for money paid in advance, then shows it as Advance', async () => {
    const o = (await newOrder()).body.order; // 2949.97
    const pay = (body) => api().post(`/api/orders/${o.id}/payments`).send({ amount: '3000', txn_date: today(), payment_method: method, ...body });

    const refused = await pay({});
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('That is more than the balance of ₹2949.97. If the customer is paying in advance, confirm it to record the payment.');

    const ok = await pay({ confirm_advance: true });
    expect(ok.status).toBe(201);
    expect(ok.body.order.payment_state).toBe('Advance'); // paid more than the items, goods not shipped yet

    const more = await pay({ amount: '10' });
    expect(more.body.error).toMatch(/already fully paid/);
  });

  it('checks amount, date and method', async () => {
    const o = (await newOrder()).body.order;
    const pay = (body) => api().post(`/api/orders/${o.id}/payments`).send({ amount: '10', txn_date: today(), payment_method: method, ...body });
    expect((await pay({ amount: '0' })).body.error).toMatch(/payment amount must be a number above 0/);
    expect((await pay({ amount: '10.555' })).status).toBe(400);
    expect((await pay({ txn_date: '2999-01-01' })).body.error).toBe('The payment date cannot be in the future.');
    expect((await pay({ payment_method: 'Barter' })).body.error).toBe('Please choose a valid payment method.');
  });
});

describe('list and existing orders', () => {
  it('lists and filters orders, with totals', async () => {
    const o = (await newOrder()).body.order;
    const found = await api().get('/api/orders').query({ search: o.code });
    expect(found.body.orders.map((x) => x.id)).toEqual([o.id]);
    expect((await api().get('/api/orders').query({ search: o.code, payment: 'Paid' })).body.orders).toEqual([]);
    expect((await api().get('/api/orders').query({ search: 'Zz Order Customer', status: 'Pending' })).body.orders.length).toBeGreaterThan(0);
    expect(found.body.totals.to_collect).toMatch(/^\d+\.\d{2}$/);
  });

  it('keeps the original orders consistent', async () => {
    const rows = await sql(
      `SELECT os.order_code, os.items_total, os.shipping_charged, os.order_total, os.received, os.balance,
              (SELECT SUM(quantity * unit_price - discount) FROM order_item i WHERE i.order_id = os.order_id) AS lines_total
         FROM order_summary os WHERE os.order_code IN ('SO_0000001', 'SO_0000002', 'SO_0000003', 'SO_0000004')`,
    );
    expect(rows.rowCount).toBe(4);
    for (const r of rows.rows) {
      expect(r.items_total).toBe(r.lines_total);
      expect(Number(r.order_total)).toBeCloseTo(Number(r.items_total) + Number(r.shipping_charged), 2);
      expect(Number(r.balance)).toBeCloseTo(Number(r.order_total) - Number(r.received), 2);
    }
    const shipped = await api().get('/api/orders').query({ search: 'SO_0000003' });
    const order = (await api().get(`/api/orders/${shipped.body.orders[0].id}`)).body.order;
    expect(order.editable).toBe(false);
    expect(order.parcels.length).toBeGreaterThan(0);
  });
});

describe('database permissions', () => {
  const tryDelete = async (text) => {
    await t.client.query('SAVEPOINT perm');
    try {
      await t.client.query(text);
      return 'allowed';
    } catch (err) {
      return err.code;
    } finally {
      await t.client.query('ROLLBACK TO SAVEPOINT perm');
    }
  };
  it('lets the app delete order lines only, never orders, payments or movements', async () => {
    expect(await tryDelete('DELETE FROM order_item WHERE false')).toBe('allowed');
    for (const table of ['customer_order', 'payment_transaction', 'inventory_movement', 'purchase_order', 'shipment']) {
      expect(await tryDelete(`DELETE FROM ${table} WHERE false`)).toBe('42501'); // permission denied
    }
  });
});
