import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import Decimal from 'decimal.js';
import { closePool, query } from '../src/db.js';
import { startTestApp } from './helpers.js';

let t;
let X; // list 499.99, cost 100
let Y; // list 500.00, cost 100
let orderA;
let orderB;

const api = () => request(t.app);
const sql = (text, params = []) => query(text, params, t.client);
const sum = (values) => values.reduce((s, v) => s.plus(v), new Decimal(0));
const get = async (path, params = {}) => {
  const res = await api().get(`/api/reports/${path}`).query(params);
  expect(res.status).toBe(200);
  return res.body;
};
// the month n months before this one, as YYYY-MM (India time)
const monthsAgo = (n) => {
  const [y, m] = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7).split('-').map(Number);
  const index = y * 12 + (m - 1) - n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
};
const MARCH_APRIL = { from: '2019-03', to: '2019-04' }; // months with no other data in the database
const MARCH = { from: '2019-03', to: '2019-03' };
const APRIL = { from: '2019-04', to: '2019-04' };

beforeAll(async () => {
  t = await startTestApp();
  const customer = (await api().post('/api/customers').send({ name: 'Zz Report Customer', phone: '+91 90000 44441' })).body.item.id;
  const product = (await api().post('/api/products').send({ name: 'Zz Report Product' })).body;
  const make = async (sku, size, price) =>
    (await api().post('/api/variants').send({ product_id: product.id, fabric: 'Cotton', size, colour: 'Black', unit_cost: '100.00', list_price: price, sku })).body.variant;
  X = await make('ZZR-M-BLK', 'M', '499.99');
  Y = await make('ZZR-L-BLK', 'L', '500.00');
  for (const v of [X, Y]) await api().post('/api/inventory/adjustments').send({ variant_id: v.variant_id, direction: 'add', quantity: 50, reason: 'Test stock' });
  const method = (await api().get('/api/orders/lookups')).body.methods[0];
  const courier = (await t.client.query("SELECT supplier_id FROM supplier WHERE supplier_code = 'SPLR0004'")).rows[0].supplier_id;

  // MARCH 2019: order A (3 x X at 499.99 less 50.00, 1 x Y at 500), shipped 12 Mar with 40 charged / 30 courier cost
  orderA = (await api().post('/api/orders').send({
    customer_id: customer, order_date: '2019-03-10',
    lines: [{ variant_id: X.variant_id, quantity: 3, unit_price: '499.99', discount: '50.00' }, { variant_id: Y.variant_id, quantity: 1 }],
  })).body.order;
  const parcel = await api().post('/api/shipments').send({
    lines: orderA.lines.map((l) => ({ order_item_id: l.item_id, quantity: l.quantity })),
    courier_id: courier, shipped_on: '2019-03-12', courier_cost: '30', shipping_charge: '40',
  });
  expect(parcel.status).toBe(201);
  await api().post(`/api/orders/${orderA.id}/payments`).send({ amount: '1989.97', txn_date: '2019-03-15', payment_method: method });
  // a purchase in March, paid 300 in March
  const lookups = (await api().get('/api/purchases/lookups')).body;
  const po = await api().post('/api/purchases').send({
    supplier_id: lookups.suppliers[0].id, order_date: '2019-03-05', purchase_type: lookups.types.find((x) => x.affects_stock).name,
    lines: [{ variant_id: X.variant_id, quantity: 5 }],
  });
  expect(po.status).toBe(201);
  await api().post(`/api/purchases/${po.body.purchase.id}/payments`).send({ amount: '300', txn_date: '2019-03-20', payment_method: method });
  // APRIL 2019: order B (2 x X at list), paid 1100 in advance, 100.02 refunded; the courier for March is paid on 2 April
  orderB = (await api().post('/api/orders').send({ customer_id: customer, order_date: '2019-04-05', lines: [{ variant_id: X.variant_id, quantity: 2 }] })).body.order;
  await api().post(`/api/orders/${orderB.id}/payments`).send({ amount: '1100', txn_date: '2019-04-06', payment_method: method, confirm_advance: true });
  const refund = await api().post(`/api/orders/${orderB.id}/refunds`).send({ amount: '100.02', txn_date: '2019-04-08', payment_method: method, reason: 'Test refund' });
  expect(refund.status).toBe(201);
  const settle = await api().post('/api/courier/settlements').send({
    courier_id: courier, month: '2019-03', shipment_ids: [parcel.body.shipment.id], amount: '30', paid_on: '2019-04-02', payment_method: method,
  });
  expect(settle.status).toBe(201);
});
afterAll(async () => {
  await t.stop();
  await closePool();
});

describe('known months (exact figures)', () => {
  it('March: sales, cost and profit exclude shipping; money in, out and shipping land in the right month', async () => {
    const o = await get('overview', MARCH);
    expect(o.sales).toMatchObject({ orders: 1, pieces: 4, sales: '1949.97', cost: '400.00', profit: '1549.97', margin_percent: '79.5' });
    expect(o.money).toMatchObject({ in: '1989.97', out: '300.00', net: '1689.97', to_suppliers: '300.00', to_couriers: '0.00', refunds: '0.00', expenses: '0.00' });
    expect(o.shipping).toMatchObject({ parcels: 1, charged: '40.00', courier_cost: '30.00', difference: '10.00' });
  });

  it('April: a refund and the courier payment count as money out', async () => {
    const o = await get('overview', APRIL);
    expect(o.sales).toMatchObject({ orders: 1, pieces: 2, sales: '999.98', cost: '200.00', profit: '799.98' });
    expect(o.money).toMatchObject({ in: '1100.00', out: '130.02', net: '969.98', to_suppliers: '0.00', to_couriers: '30.00', refunds: '100.02' });
    expect(o.shipping).toMatchObject({ parcels: 0, charged: '0.00', courier_cost: '0.00' });
  });

  it('a two-month range adds the months up, and the monthly rows agree', async () => {
    const o = await get('overview', MARCH_APRIL);
    expect(o.sales).toMatchObject({ orders: 2, sales: '2949.95', cost: '600.00', profit: '2349.95' });
    expect(o.money).toMatchObject({ in: '3089.97', out: '430.02', net: '2659.95' });

    const { months } = await get('monthly', MARCH_APRIL);
    expect(months.map((m) => m.month)).toEqual(['2019-03', '2019-04']);
    expect(months[0]).toMatchObject({ sales: '1949.97', profit: '1549.97', money_in: '1989.97', money_out: '300.00', net: '1689.97', ship_charged: '40.00', ship_cost: '30.00', ship_difference: '10.00' });
    expect(months[1]).toMatchObject({ sales: '999.98', profit: '799.98', money_in: '1100.00', money_out: '130.02', to_couriers: '30.00', refunds: '100.02', net: '969.98' });
    expect(sum(months.map((m) => m.sales)).toFixed(2)).toBe(o.sales.sales);
    expect(sum(months.map((m) => m.money_out)).toFixed(2)).toBe(o.money.out);
  });

  it('by product and by month and product', async () => {
    const byProduct = await get('products', MARCH_APRIL);
    expect(byProduct.items).toHaveLength(1);
    expect(byProduct.items[0]).toMatchObject({ name: 'Zz Report Product', pieces: 6, sales: '2949.95', cost: '600.00', profit: '2349.95', share_percent: '100' });

    const bySku = await get('products', { ...MARCH_APRIL, group: 'variant' });
    expect(bySku.items.map((i) => [i.name, i.pieces, i.sales])).toEqual([
      ['ZZR-M-BLK - Zz Report Product', 5, '2449.95'],
      ['ZZR-L-BLK - Zz Report Product', 1, '500.00'],
    ]);

    const matrix = await get('product-months', MARCH_APRIL);
    expect(matrix.months).toEqual(['2019-03', '2019-04']);
    expect(matrix.products[0]).toMatchObject({ name: 'Zz Report Product', total_sales: '2949.95', total_profit: '2349.95' });
    expect(matrix.products[0].cells).toEqual([{ sales: '1949.97', profit: '1549.97' }, { sales: '999.98', profit: '799.98' }]);
    expect(matrix.column_totals).toEqual([{ sales: '1949.97', profit: '1549.97' }, { sales: '999.98', profit: '799.98' }]);
  });

  it('an empty period gives zeros, not an error', async () => {
    const o = await get('overview', { from: '2001-01', to: '2001-02' });
    expect(o.sales).toMatchObject({ orders: 0, sales: '0.00', profit: '0.00', margin_percent: null });
    expect(o.money).toMatchObject({ in: '0.00', out: '0.00', net: '0.00' });
    const { months } = await get('monthly', { from: '2001-01', to: '2001-02' });
    expect(months).toHaveLength(2);
    expect(months.every((m) => m.sales === '0.00' && m.orders === 0)).toBe(true);
    expect((await get('products', { from: '2001-01', to: '2001-02' })).items).toEqual([]);
  });
});

describe('every report agrees with the rest of the app (all time)', () => {
  it('sales, cost, profit and the product totals equal the order views', async () => {
    const view = (await sql('SELECT SUM(items_total) AS sales, SUM(product_cost) AS cost, SUM(profit) AS profit, SUM(ordered_qty)::int AS pieces, COUNT(*)::int AS orders FROM order_summary')).rows[0];
    const o = await get('overview');
    expect(o.sales).toMatchObject({ sales: new Decimal(view.sales).toFixed(2), cost: new Decimal(view.cost).toFixed(2), profit: new Decimal(view.profit).toFixed(2), pieces: view.pieces, orders: view.orders });
    const products = await get('products');
    expect(sum(products.items.map((i) => i.sales)).toFixed(2)).toBe(o.sales.sales);
  });

  it('the month-by-month tables add up to the overview for the same recent period', async () => {
    const period = { from: monthsAgo(11) }; // the last 12 months (a month list is capped at 60 months)
    const o = await get('overview', period);
    const monthly = await get('monthly', period);
    expect(monthly.months).toHaveLength(12);
    expect(sum(monthly.months.map((m) => m.sales)).toFixed(2)).toBe(o.sales.sales);
    expect(sum(monthly.months.map((m) => m.profit)).toFixed(2)).toBe(o.sales.profit);
    expect(sum(monthly.months.map((m) => m.money_in)).toFixed(2)).toBe(o.money.in);
    expect(sum(monthly.months.map((m) => m.money_out)).toFixed(2)).toBe(o.money.out);
    expect(sum(monthly.months.map((m) => m.net)).toFixed(2)).toBe(o.money.net);
    expect(sum(monthly.months.map((m) => m.ship_charged)).toFixed(2)).toBe(o.shipping.charged);
    const matrix = await get('product-months', period);
    expect(sum(matrix.products.map((p) => p.total_sales)).toFixed(2)).toBe(o.sales.sales);
    expect(sum(matrix.column_totals.map((c) => c.sales)).toFixed(2)).toBe(o.sales.sales);
    expect(sum(matrix.column_totals.map((c) => c.profit)).toFixed(2)).toBe(o.sales.profit);
  });

  it('money in and out equal the payments, refunds and courier settlements', async () => {
    const pay = (await sql(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'In'), 0) AS money_in,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'Out'), 0) AS pay_out
         FROM payment_transaction WHERE payment_status = 'Completed'`,
    )).rows[0];
    const courier = (await sql('SELECT COALESCE(SUM(amount), 0) AS total FROM courier_settlement')).rows[0].total;
    const o = await get('overview');
    expect(o.money.in).toBe(new Decimal(pay.money_in).toFixed(2));
    expect(o.money.out).toBe(new Decimal(pay.pay_out).plus(courier).toFixed(2));
    expect(o.money.net).toBe(new Decimal(pay.money_in).minus(pay.pay_out).minus(courier).toFixed(2));
  });

  it('what is owed, to collect and the shipping figures equal the database views', async () => {
    const o = await get('overview');
    const owedSuppliers = (await sql('SELECT COALESCE(SUM(balance) FILTER (WHERE balance > 0), 0) AS v FROM purchase_order_summary')).rows[0].v;
    const owedCouriers = (await sql('SELECT COALESCE(SUM(amount_due), 0) AS v FROM courier_payable')).rows[0].v;
    const orders = (await sql('SELECT COALESCE(SUM(balance) FILTER (WHERE balance > 0), 0) AS collect, COALESCE(SUM(-balance) FILTER (WHERE balance < 0), 0) AS credit FROM order_summary')).rows[0];
    const ship = (await sql('SELECT COALESCE(SUM(shipping_charged), 0) AS charged, COALESCE(SUM(courier_cost), 0) AS cost FROM shipping_monthly')).rows[0];
    expect(o.owed).toMatchObject({
      to_suppliers: new Decimal(owedSuppliers).toFixed(2), to_couriers: new Decimal(owedCouriers).toFixed(2),
      to_collect: new Decimal(orders.collect).toFixed(2), credit_held: new Decimal(orders.credit).toFixed(2),
    });
    expect(o.shipping).toMatchObject({ charged: new Decimal(ship.charged).toFixed(2), courier_cost: new Decimal(ship.cost).toFixed(2) });

    const pay = await get('payables');
    expect(sum(pay.suppliers.map((s) => s.balance)).toFixed(2)).toBe(o.owed.to_suppliers);
    expect(sum(pay.purchases.map((p) => p.balance)).toFixed(2)).toBe(o.owed.to_suppliers);
    expect(sum(pay.couriers.map((c) => c.amount_due)).toFixed(2)).toBe(o.owed.to_couriers);
    expect(sum(pay.orders.map((x) => x.balance)).toFixed(2)).toBe(o.owed.to_collect);
  });

  it('stock value equals the inventory, per product and per variant, and the Inventory screen', async () => {
    const view = (await sql('SELECT SUM(on_hand)::int AS pieces, SUM(on_hand * unit_cost) AS value FROM inventory_balance')).rows[0];
    const o = await get('overview');
    expect(o.stock).toMatchObject({ pieces: view.pieces, value: new Decimal(view.value).toFixed(2) });
    for (const group of ['product', 'variant']) {
      const stock = await get('stock', { group });
      expect(stock.totals).toEqual({ on_hand: view.pieces, value: new Decimal(view.value).toFixed(2) });
    }
    const inventory = await api().get('/api/inventory');
    expect(inventory.body.totals).toMatchObject({ pieces: view.pieces, value: new Decimal(view.value).toFixed(2) });
  });

  it('hidden variants still count as stock on the Inventory screen and in the reports', async () => {
    const before = (await api().get('/api/inventory')).body.totals;
    await api().post(`/api/variants/${Y.variant_id}/deactivate`);
    const after = (await api().get('/api/inventory')).body.totals;
    expect(after).toEqual(before);
    expect((await get('overview')).stock.value).toBe(before.value);
    await api().post(`/api/variants/${Y.variant_id}/activate`);
  });
});

describe('plain-English refusals', () => {
  it('rejects a backwards or malformed period, and a period that is too long', async () => {
    const back = await api().get('/api/reports/overview').query({ from: '2019-05', to: '2019-03' });
    expect(back.status).toBe(400);
    expect(back.body.error).toBe("The 'from' month can't be after the 'to' month.");
    const bad = await api().get('/api/reports/monthly').query({ from: 'March' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Please choose a valid month.');
    const long = await api().get('/api/reports/monthly').query({ from: '2000-01', to: '2020-01' });
    expect(long.status).toBe(400);
    expect(long.body.error).toBe('Please choose a shorter period (60 months at most).');
  });

  it('"all time" with a very long history shows only the latest 60 months and says so', async () => {
    // the test data starts in 2019, which is more than 60 months ago
    const all = await get('monthly');
    expect(all.truncated).toBe(true);
    expect(all.months).toHaveLength(60);
    expect(all.months.at(-1).month).toBe(monthsAgo(0));
    const recent = await get('monthly', { from: monthsAgo(11) });
    expect(recent.truncated).toBe(false);
  });

  it('is read-only: the reports offer no way to change anything', async () => {
    for (const method of ['post', 'put', 'patch', 'delete']) {
      expect((await api()[method]('/api/reports/overview').send({})).status).toBe(404);
    }
  });
});
