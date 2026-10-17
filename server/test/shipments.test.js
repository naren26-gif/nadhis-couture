import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closePool, query } from '../src/db.js';
import { startTestApp } from './helpers.js';

let t;
let custA;
let custB;
let variantA; // list 500.00
let variantB; // list 300.00
let courierId;

const api = () => request(t.app);
const sql = (text, params = []) => query(text, params, t.client);
const indiaDate = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const today = () => indiaDate(0);
const number = (code) => Number(code.replace(/^\D+/, ''));

beforeAll(async () => {
  t = await startTestApp();
  custA = (await api().post('/api/customers').send({ name: 'Zz Ship Customer A', phone: '+91 90000 66661' })).body.item.id;
  custB = (await api().post('/api/customers').send({ name: 'Zz Ship Customer B', phone: '+91 90000 66662' })).body.item.id;
  const product = await api().post('/api/products').send({ name: 'Zz Ship Product' });
  const make = async (sku, size, price) =>
    (await api().post('/api/variants').send({
      product_id: product.body.id, fabric: 'Cotton', size, colour: 'Black', unit_cost: '100.00', list_price: price, sku,
    })).body.variant;
  variantA = await make('ZZH-M-BLK', 'M', '500.00');
  variantB = await make('ZZH-L-BLK', 'L', '300.00');
  courierId = (await sql("SELECT supplier_id FROM supplier WHERE supplier_code = 'SPLR0004'")).rows[0].supplier_id;
  await stock(variantA, 5);
  await stock(variantB, 1);
});
afterAll(async () => {
  await t.stop();
  await closePool();
});

const stock = (variant, quantity) =>
  api().post('/api/inventory/adjustments').send({ variant_id: variant.variant_id, direction: 'add', quantity, reason: 'Test stock' });
const onHand = async (variant) => (await api().get('/api/inventory').query({ search: variant.sku })).body.variants[0].on_hand;
const newOrder = async (customer, lines, overrides = {}) => {
  const res = await api().post('/api/orders').send({
    customer_id: customer, order_date: today(), lines: lines.map(([variant, quantity]) => ({ variant_id: variant.variant_id, quantity })), ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body.order;
};
const getOrder = async (o) => (await api().get(`/api/orders/${o.id}`)).body.order;
const ship = (items, overrides = {}) =>
  api().post('/api/shipments').send({
    lines: items.map(([order, index, quantity]) => ({ order_item_id: order.lines[index].item_id, quantity })),
    courier_id: courierId, shipping_charge: '0', courier_cost: '0', ...overrides,
  });

describe('sending parcels', () => {
  it('ships what is in stock now (partial), charges shipping on the order, and then ships the rest', async () => {
    const o = await newOrder(custA, [[variantA, 3], [variantB, 2]]); // B: only 1 in stock
    const first = await ship([[o, 0, 3], [o, 1, 1]], { shipping_charge: '60', courier_cost: '45', tracking_number: 'TRK1' });
    expect(first.status).toBe(201);
    const p = first.body.shipment;
    expect(p).toMatchObject({ status: 'Shipped', units: 4, tracking_number: 'TRK1', courier: 'ST Courier', shipping_charged: '60.00', courier_cost: '45.00', shipping_margin: '15.00', paid_to_courier: false });
    expect(p.code).toMatch(/^SH_\d{7}$/);
    expect(p.billed_order).toBe(o.code);

    const now = await getOrder(o);
    expect(now).toMatchObject({ status: 'Partially Shipped', shipped_qty: 4, items_total: '2100.00', shipping_charged: '60.00', order_total: '2160.00', balance: '2160.00' });
    expect(await onHand(variantA)).toBe(2); // 5 - 3
    expect(await onHand(variantB)).toBe(0);

    await stock(variantB, 4);
    const rest = await ship([[o, 1, 1]], { shipping_charge: '0' });
    expect(rest.status).toBe(201);
    expect((await getOrder(o)).status).toBe('Shipped');
    expect(await onHand(variantB)).toBe(4);
    await stock(variantA, 3); // keep A at 5 for the next tests
  });

  it('refuses in plain English and changes nothing: not enough stock, too many, finished orders', async () => {
    const o = await newOrder(custA, [[variantB, 9]]);
    const before = await onHand(variantB);
    const noStock = await ship([[o, 0, 9]]);
    expect(noStock.status).toBe(400);
    expect(noStock.body.error).toBe(`Not enough stock for ZZH-L-BLK: only ${before} in stock.`);
    const tooMany = await ship([[o, 0, 10]]);
    expect(tooMany.body.error).toBe(`Only 9 left to ship on ZZH-L-BLK (${o.code}).`);
    expect(await onHand(variantB)).toBe(before);
    expect((await getOrder(o)).status).toBe('Pending');

    await stock(variantB, 9);
    expect((await ship([[o, 0, 9]])).status).toBe(201);
    const again = await ship([[o, 0, 1]]);
    expect(again.body.error).toBe(`${o.code} has already been fully shipped.`);
  });

  it('checks the date, the courier and an empty parcel', async () => {
    const o = await newOrder(custA, [[variantA, 1]]);
    const early = await ship([[o, 0, 1]], { shipped_on: indiaDate(3) });
    expect(early.body.error).toBe(`The ship date can't be before the order date (${today()}) of ${o.code}.`);
    expect((await ship([[o, 0, 1]], { shipped_on: '2999-01-01' })).body.error).toBe('The ship date cannot be in the future.');
    expect((await ship([[o, 0, 1]], { courier_id: '11111111-1111-4111-8111-111111111111' })).body.error).toBe('That courier was not found.');
    expect((await ship([])).body.error).toBe('Please choose at least one item to ship.');
    expect((await ship([[o, 0, 0]])).body.error).toBe('The quantity must be a whole number, 1 or more.');
    expect((await ship([[o, 0, 1]], { shipping_charge: '-5' })).status).toBe(400);
    expect((await getOrder(o)).status).toBe('Pending'); // nothing above shipped it
  });

  it('combines orders of one customer in one parcel and bills the chosen order', async () => {
    const x = await newOrder(custA, [[variantA, 1]]);
    const y = await newOrder(custA, [[variantA, 1]]);
    const parcel = await ship([[x, 0, 1], [y, 0, 1]], { shipping_charge: '80', bill_order_id: y.id });
    expect(parcel.status).toBe(201);
    expect(parcel.body.shipment).toMatchObject({ units: 2, billed_order: y.code });
    expect(parcel.body.shipment.lines.map((l) => l.order_code).sort()).toEqual([x.code, y.code].sort());
    expect((await getOrder(x)).shipping_charged).toBe('0.00');
    expect((await getOrder(y)).shipping_charged).toBe('80.00');

    const z = await newOrder(custA, [[variantA, 1]]);
    const w = await newOrder(custA, [[variantA, 1]]);
    const wrongBill = await ship([[z, 0, 1]], { bill_order_id: w.id });
    expect(wrongBill.body.error).toBe('The shipping charge must be billed on one of the orders in this parcel.');
    const defaultBill = await ship([[w, 0, 1], [z, 0, 1]], { shipping_charge: '10' });
    expect(defaultBill.body.shipment.billed_order).toBe([z.code, w.code].sort()[0]); // earliest order code when dates tie
  });

  it('never mixes customers, and never combines walk-in orders', async () => {
    const a = await newOrder(custA, [[variantA, 1]]);
    const b = await newOrder(custB, [[variantA, 1]]);
    expect((await ship([[a, 0, 1], [b, 0, 1]])).body.error).toBe('A parcel can only carry items for one customer.');
    const g1 = await newOrder(null, [[variantA, 1]]);
    const g2 = await newOrder(null, [[variantA, 1]]);
    expect((await ship([[g1, 0, 1], [g2, 0, 1]])).body.error).toBe('Walk-in orders cannot be combined with other orders in one parcel.');
    expect((await getOrder(a)).status).toBe('Pending');
  });

  it('gives gapless SH_ codes even after a refused shipment inside the database (needs migration 005)', async () => {
    const o = await newOrder(custA, [[variantA, 3]]);
    const first = await ship([[o, 0, 1]]);
    const code1 = first.body.shipment.code;
    // a shipment the database itself refuses, after it has already created the parcel row
    await t.client.query('SAVEPOINT bad');
    await expect(
      sql('SELECT ship_items($1::jsonb, $2, $3::date, 0, NULL, $4, 0)', [JSON.stringify([{ order_item_id: o.lines[0].item_id, quantity: 999 }]), courierId, today(), 'Test']),
    ).rejects.toThrow();
    await t.client.query('ROLLBACK TO SAVEPOINT bad');
    const second = await ship([[o, 0, 1]]);
    expect(number(second.body.shipment.code)).toBe(number(code1) + 1);
  });
});

describe('after sending', () => {
  const freshParcel = async (extra = {}) => {
    const o = await newOrder(custB, [[variantA, 1]]);
    const res = await ship([[o, 0, 1]], extra);
    expect(res.status).toBe(201);
    return { order: o, parcel: res.body.shipment };
  };

  it('moves Shipped -> In Transit -> Delivered, and the order becomes Delivered with its last parcel', async () => {
    const { order, parcel } = await freshParcel();
    const transit = await api().post(`/api/shipments/${parcel.id}/status`).send({ status: 'In Transit' });
    expect(transit.body.shipment.status).toBe('In Transit');
    expect((await api().post(`/api/shipments/${parcel.id}/status`).send({ status: 'In Transit' })).body.error).toBe('This parcel is already in transit.');

    const early = await api().post(`/api/shipments/${parcel.id}/status`).send({ status: 'Delivered', delivered_on: indiaDate(5) });
    expect(early.body.error).toBe(`The delivery date can't be before the ship date (${today()}).`);
    expect((await api().post(`/api/shipments/${parcel.id}/status`).send({ status: 'Delivered', delivered_on: '2999-01-01' })).body.error).toBe('The delivery date cannot be in the future.');
    expect((await getOrder(order)).status).toBe('Shipped');

    const done = await api().post(`/api/shipments/${parcel.id}/status`).send({ status: 'Delivered', delivered_on: today() });
    expect(done.body.shipment).toMatchObject({ status: 'Delivered', delivered_on: today() });
    expect((await getOrder(order)).status).toBe('Delivered');
    expect((await api().post(`/api/shipments/${parcel.id}/status`).send({ status: 'In Transit' })).body.error).toBe('This parcel is already delivered, and that cannot be undone.');
  });

  it('lets anyone fix tracking and note, only the owner fix money, and locks the courier cost once paid', async () => {
    const { order, parcel } = await freshParcel({ shipping_charge: '50', courier_cost: '40' });
    const staff = (body) => api().patch(`/api/shipments/${parcel.id}`).set('x-test-role', 'staff').send(body);

    const track = await staff({ tracking_number: 'ABC123', note: 'Left with neighbour' });
    expect(track.body.shipment).toMatchObject({ tracking_number: 'ABC123', note: 'Left with neighbour' });
    const money = await staff({ shipping_charge: '70' });
    expect(money.status).toBe(403);
    expect(money.body.error).toBe('Only the owner can change the courier cost or the shipping charge.');

    const owner = await api().patch(`/api/shipments/${parcel.id}`).send({ shipping_charge: '70', courier_cost: '42.50' });
    expect(owner.body.shipment).toMatchObject({ shipping_charged: '70.00', courier_cost: '42.50', shipping_margin: '27.50' });
    expect((await getOrder(order)).shipping_charged).toBe('70.00');

    // once the courier has been paid for this parcel, its cost is fixed
    const settlement = await sql(
      `INSERT INTO courier_settlement (settlement_code, courier_supplier_id, period_month, paid_on, amount)
       VALUES ('CS_TEST_1', $1, date_trunc('month', CURRENT_DATE)::date, CURRENT_DATE, 42.50) RETURNING settlement_id`,
      [courierId],
    );
    await sql('UPDATE shipment SET courier_settlement_id = $1 WHERE shipment_id = $2', [settlement.rows[0].settlement_id, parcel.id]);
    const locked = await api().patch(`/api/shipments/${parcel.id}`).send({ courier_cost: '50' });
    expect(locked.body.error).toBe("This parcel has already been paid to the courier, so its courier cost can't change.");
    expect((await api().patch(`/api/shipments/${parcel.id}`).send({ courier_cost: '42.50', note: 'ok' })).status).toBe(200);
    expect((await api().get(`/api/shipments/${parcel.id}`)).body.shipment).toMatchObject({ paid_to_courier: true, settlement_code: 'CS_TEST_1' });
  });
});

describe('lists and what to buy', () => {
  it('lists parcels with filters and totals, including the original three', async () => {
    const all = await api().get('/api/shipments');
    expect(all.status).toBe(200);
    const codes = all.body.shipments.map((s) => s.code);
    for (const code of ['SH_0000001', 'SH_0000002', 'SH_0000003']) expect(codes).toContain(code);
    const combined = all.body.shipments.find((s) => s.code === 'SH_0000003');
    expect(combined.orders.map((o) => o.code).sort()).toEqual(['SO_0000003', 'SO_0000004']);
    expect(combined.courier).toBe('ST Courier');
    expect(all.body.totals.courier_unpaid).toMatch(/^\d+\.\d{2}$/);

    expect((await api().get('/api/shipments').query({ search: 'SO_0000004' })).body.shipments.map((s) => s.code)).toContain('SH_0000003');
    for (const s of (await api().get('/api/shipments').query({ status: 'Shipped' })).body.shipments) expect(s.status).toBe('Shipped');
    for (const s of (await api().get('/api/shipments').query({ courier_payment: 'Unpaid' })).body.shipments) expect(s.paid_to_courier).toBe(false);
  });

  it('shows orders ready to ship, what to buy, and the dialog data for an order and its customer', async () => {
    await stock(variantB, 0 + 1);
    const ready = await newOrder(custA, [[variantA, 1]]);
    const waiting = await newOrder(custA, [[variantB, 50]]);
    const other = await newOrder(custB, [[variantA, 1]]);

    const list = await api().get('/api/shipments/ready');
    const mine = list.body.orders.find((o) => o.id === ready.id);
    expect(mine).toMatchObject({ ready_units: 1, remaining_units: 1, short_units: 0, customer_name: 'Zz Ship Customer A' });
    const partlyReady = list.body.orders.find((o) => o.id === waiting.id);
    expect(partlyReady.short_units).toBeGreaterThan(0);

    const buy = await api().get('/api/shipments/to-buy');
    const row = buy.body.items.find((i) => i.sku === 'ZZH-L-BLK');
    expect(row.units_to_buy).toBe(row.units_waiting - row.on_hand);

    const dialog = await api().get('/api/shipments/candidates').query({ order_id: ready.id });
    expect(dialog.body.order).toMatchObject({ code: ready.code, can_ship: true });
    const ids = dialog.body.lines.map((l) => l.order_id);
    expect(ids).toContain(ready.id);
    expect(ids).toContain(waiting.id); // same customer, so it can ride in the same parcel
    expect(ids).not.toContain(other.id); // another customer never can
    expect(dialog.body.lines[0].this_order).toBe(true);
    expect(dialog.body.couriers.some((c) => c.code === 'SPLR0004')).toBe(true);
    expect(dialog.body.today).toBe(today());

    const guest = await newOrder(null, [[variantA, 1]]);
    const guestDialog = await api().get('/api/shipments/candidates').query({ order_id: guest.id });
    expect(new Set(guestDialog.body.lines.map((l) => l.order_id))).toEqual(new Set([guest.id]));
  });
});
