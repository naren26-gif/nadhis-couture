import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closePool, query } from '../src/db.js';
import { startTestApp } from './helpers.js';

let t;
let customer;
let variant;
let stCourier; // the real courier (SPLR0004)
let otherCourier; // a second courier made in the test
let method;

const api = () => request(t.app);
const sql = (text, params = []) => query(text, params, t.client);
const indiaDate = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const today = () => indiaDate(0);
const thisMonth = () => today().slice(0, 7);
const number = (code) => Number(code.replace(/^\D+/, ''));

beforeAll(async () => {
  t = await startTestApp();
  customer = (await api().post('/api/customers').send({ name: 'Zz Courier Customer', phone: '+91 90000 55551' })).body.item.id;
  const product = await api().post('/api/products').send({ name: 'Zz Courier Product' });
  variant = (await api().post('/api/variants').send({
    product_id: product.body.id, fabric: 'Cotton', size: 'M', colour: 'Black', unit_cost: '100.00', list_price: '500.00', sku: 'ZZC-M-BLK',
  })).body.variant;
  await api().post('/api/inventory/adjustments').send({ variant_id: variant.variant_id, direction: 'add', quantity: 200, reason: 'Test stock' });
  stCourier = (await sql("SELECT supplier_id FROM supplier WHERE supplier_code = 'SPLR0004'")).rows[0].supplier_id;
  otherCourier = (await api().post('/api/suppliers').send({ name: 'Zz Other Courier', phone: '+91 90000 55552' })).body.item.id;
  method = (await api().get('/api/courier/payable')).body.methods[0];
});
afterAll(async () => {
  await t.stop();
  await closePool();
});

// one new order and one parcel for it, with the given courier cost
const parcel = async (cost, { courier = stCourier, daysAgo = 0 } = {}) => {
  const date = indiaDate(daysAgo);
  const order = await api().post('/api/orders').send({ customer_id: customer, order_date: date, lines: [{ variant_id: variant.variant_id, quantity: 1 }] });
  expect(order.status).toBe(201);
  const res = await api().post('/api/shipments').send({
    lines: [{ order_item_id: order.body.order.lines[0].item_id, quantity: 1 }],
    courier_id: courier, shipped_on: date, courier_cost: cost, shipping_charge: '0',
  });
  expect(res.status).toBe(201);
  return res.body.shipment;
};
const settle = (shipments, overrides = {}) =>
  api().post('/api/courier/settlements').send({
    courier_id: stCourier, month: thisMonth(), shipment_ids: shipments.map((s) => s.id),
    amount: shipments.reduce((sum, s) => sum + Math.round(Number(s.courier_cost) * 100), 0) / 100 + '', // exact for 2 decimals here
    paid_on: today(), payment_method: method, ...overrides,
  });
const owed = async (courier = stCourier, month = thisMonth()) => {
  const g = (await api().get('/api/courier/payable')).body.groups.find((x) => x.courier_id === courier && x.month === month);
  return g ? Number(g.amount_due) : 0;
};

describe('what is waiting to be paid', () => {
  it('matches the courier_payable view, including the original parcels', async () => {
    const view = await sql("SELECT courier, to_char(month, 'YYYY-MM') AS month, shipments::int AS parcels, amount_due FROM courier_payable WHERE amount_due > 0");
    const groups = (await api().get('/api/courier/payable')).body.groups;
    expect(groups.length).toBe(view.rowCount);
    for (const row of view.rows) {
      const g = groups.find((x) => x.courier === row.courier && x.month === row.month);
      expect(g).toBeTruthy();
      expect(g.parcels).toBe(row.parcels);
      expect(Number(g.amount_due)).toBeCloseTo(Number(row.amount_due), 2);
    }
    const original = await sql("SELECT 1 FROM shipment WHERE shipment_code IN ('SH_0000001','SH_0000002','SH_0000003') AND courier_settlement_id IS NULL");
    expect(original.rowCount).toBeGreaterThan(0); // they are still waiting to be paid in dev
  });

  it('lists the unpaid parcels of a courier and month, and hides paid ones', async () => {
    const a = await parcel('12.00');
    const b = await parcel('8.50');
    const list = await api().get('/api/courier/parcels').query({ courier_id: stCourier, month: thisMonth() });
    expect(list.status).toBe(200);
    const ids = list.body.parcels.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(list.body.parcels.find((p) => p.id === a.id)).toMatchObject({ courier_cost: '12.00', units: 1 });
    await settle([a]);
    const after = await api().get('/api/courier/parcels').query({ courier_id: stCourier, month: thisMonth() });
    expect(after.body.parcels.map((p) => p.id)).not.toContain(a.id);
    expect((await api().get('/api/courier/parcels').query({ courier_id: stCourier, month: 'October' })).body.error).toBe('Please choose a valid month.');
  });
});

describe('recording the month-end payment', () => {
  it('pays a chosen set of parcels exactly, and the database agrees it matches', async () => {
    const a = await parcel('40.00');
    const b = await parcel('25.50');
    const c = await parcel('10.00');
    const before = await owed();

    const res = await settle([a, b]);
    expect(res.status).toBe(201);
    const s = res.body.settlement;
    expect(s.code).toMatch(/^CS_\d{7}$/);
    expect(s).toMatchObject({ amount_paid: '65.50', shipments_total: '65.50', difference: '0.00', reconciliation: 'Matches', parcels: 2, month: thisMonth(), courier: 'ST Courier' });
    expect(s.parcel_list.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(await owed()).toBeCloseTo(before - 65.5, 2); // exactly their cost came off what is waiting

    const paid = (await api().get(`/api/shipments/${a.id}`)).body.shipment;
    expect(paid).toMatchObject({ paid_to_courier: true, settlement_code: s.code });
    expect((await api().get(`/api/shipments/${c.id}`)).body.shipment.paid_to_courier).toBe(false);

    const view = await sql('SELECT reconciliation, difference FROM courier_settlement_summary WHERE settlement_id = $1', [s.id]);
    expect(view.rows[0]).toMatchObject({ reconciliation: 'Matches', difference: '0.00' });

    // a refused attempt uses no number: the next payment is exactly +1
    expect((await settle([a])).body.error).toBe(`${a.code} has already been paid to the courier.`);
    const next = await settle([c]);
    expect(number(next.body.settlement.code)).toBe(number(s.code) + 1);
  });

  it('needs an explanation when the amount differs, and then reports "Check" with the exact difference', async () => {
    const a = await parcel('40.00');
    const b = await parcel('25.50');
    const noNote = await settle([a, b], { amount: '60' });
    expect(noNote.status).toBe(400);
    expect(noNote.body.error).toBe("The amount paid (₹60.00) is different from the parcels' total (₹65.50). Please explain the difference in the note.");
    expect((await api().get(`/api/shipments/${a.id}`)).body.shipment.paid_to_courier).toBe(false); // nothing was saved

    const ok = await settle([a, b], { amount: '60', note: 'Courier gave a ₹5.50 discount' });
    expect(ok.status).toBe(201);
    expect(ok.body.settlement).toMatchObject({ amount_paid: '60.00', shipments_total: '65.50', difference: '-5.50', reconciliation: 'Check', note: 'Courier gave a ₹5.50 discount' });
  });

  it('refuses in plain English and saves nothing: wrong month, wrong courier, nothing chosen, zero cost, bad values', async () => {
    const mine = await parcel('15.00');
    const old = await parcel('9.00', { daysAgo: 40 }); // shipped in an earlier month
    const theirs = await parcel('7.00', { courier: otherCourier });
    const free = await parcel('0');

    expect((await settle([old], { amount: '9' })).body.error).toBe(`${old.code} was shipped in a different month than the one you chose.`);
    expect((await settle([theirs], { amount: '7' })).body.error).toBe(`${theirs.code} was sent with a different courier.`);
    expect((await settle([free], { amount: '1' })).body.error).toBe('These parcels have no courier cost, so there is nothing to pay.');
    expect((await settle([], { amount: '1' })).body.error).toBe('Please choose at least one parcel.');
    expect((await settle([mine], { amount: '0' })).body.error).toMatch(/amount paid must be a number above 0/);
    expect((await settle([mine], { amount: '15.005' })).status).toBe(400);
    expect((await settle([mine], { paid_on: '2999-01-01' })).body.error).toBe('The payment date cannot be in the future.');
    expect((await settle([mine], { payment_method: 'Barter' })).body.error).toBe('Please choose a valid payment method.');
    expect((await settle([mine], { month: 'October' })).body.error).toBe('Please choose a valid month.');
    expect((await settle([mine], { courier_id: '11111111-1111-4111-8111-111111111111' })).body.error).toBe('That courier was not found.');
    expect((await api().get(`/api/shipments/${mine.id}`)).body.shipment.paid_to_courier).toBe(false);

    // the second courier is settled on its own, in its own right
    const own = await settle([theirs], { courier_id: otherCourier, amount: '7' });
    expect(own.status).toBe(201);
    expect(own.body.settlement.courier).toBe('Zz Other Courier');
  });

  it('lists past payments and shows one with its parcels', async () => {
    const a = await parcel('11.00');
    const s = (await settle([a])).body.settlement;
    const list = await api().get('/api/courier/settlements');
    expect(list.status).toBe(200);
    const row = list.body.settlements.find((x) => x.id === s.id);
    expect(row).toMatchObject({ code: s.code, reconciliation: 'Matches', parcels: 1, amount_paid: '11.00' });
    const detail = await api().get(`/api/courier/settlements/${s.id}`);
    expect(detail.body.settlement.parcel_list.map((p) => p.code)).toEqual([a.code]);
    expect((await api().get('/api/courier/settlements/11111111-1111-4111-8111-111111111111')).status).toBe(404);
  });
});
