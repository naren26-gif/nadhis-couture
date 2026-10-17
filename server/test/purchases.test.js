import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closePool, query } from '../src/db.js';
import { startTestApp } from './helpers.js';

let t;
let supplierId;
let variantA; // master cost 100.00
let variantB; // master cost 290.10
let stockType;
let otherType; // a purchase type that does not affect stock
let method;

const api = () => request(t.app);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

beforeAll(async () => {
  t = await startTestApp();
  const supplier = await api().post('/api/suppliers').send({ name: 'Zz PO Supplier', phone: '+91 90000 77777' });
  supplierId = supplier.body.item.id;
  const product = await api().post('/api/products').send({ name: 'Zz PO Product' });
  const make = async (sku, size, cost) => {
    const res = await api().post('/api/variants').send({
      product_id: product.body.id, fabric: 'Cotton', size, colour: 'Black', unit_cost: cost, list_price: '999.00', sku,
    });
    expect(res.status).toBe(201);
    return res.body.variant;
  };
  variantA = await make('ZZP-M-BLK', 'M', '100.00');
  variantB = await make('ZZP-L-BLK', 'L', '290.10');
  const lookups = await api().get('/api/purchases/lookups');
  stockType = lookups.body.types.find((x) => x.affects_stock).name;
  otherType = lookups.body.types.find((x) => !x.affects_stock).name;
  method = lookups.body.methods[0];
});
afterAll(async () => {
  await t.stop();
  await closePool();
});

const stockPo = (overrides = {}) =>
  api().post('/api/purchases').send({
    supplier_id: supplierId,
    order_date: today(),
    purchase_type: stockType,
    lines: [
      { variant_id: variantA.variant_id, quantity: 5 },
      { variant_id: variantB.variant_id, quantity: 3, unit_cost: '290.10' },
    ],
    ...overrides,
  });
const onHand = async (variant) => (await api().get('/api/inventory').query({ search: variant.sku })).body.variants[0].on_hand;

describe('creating purchases', () => {
  it('computes the total on the server, defaults cost from the product master, and gives a PO_ code', async () => {
    const res = await stockPo();
    expect(res.status).toBe(201);
    const po = res.body.purchase;
    expect(po.code).toMatch(/^PO_\d{7}$/);
    expect(po.total_amount).toBe('1370.30'); // 5 x 100.00 + 3 x 290.10, exact
    expect(po.lines.map((l) => [l.sku, l.qty_ordered, l.unit_cost])).toEqual([
      ['ZZP-M-BLK', 5, '100.00'],
      ['ZZP-L-BLK', 3, '290.10'],
    ]);
    expect(po).toMatchObject({ payment_state: 'Unpaid', receipt_status: 'Not received', paid: '0.00', balance: '1370.30' });
    expect(await onHand(variantA)).toBe(0); // ordering does not add stock

    // next code = last + 1, no gaps
    const next = await stockPo();
    expect(Number(next.body.purchase.code.slice(3))).toBe(Number(po.code.slice(3)) + 1);
  });

  it('does not trust a total sent by the browser for stock purchases', async () => {
    const res = await stockPo({ total: '1.00' });
    expect(res.body.purchase.total_amount).toBe('1370.30');
  });

  it('needs lines for stock purchases, and refuses duplicates and hidden products', async () => {
    const none = await stockPo({ lines: [] });
    expect(none.status).toBe(400);
    expect(none.body.error).toBe('Please add at least one product line.');

    const dup = await stockPo({ lines: [{ variant_id: variantA.variant_id, quantity: 1 }, { variant_id: variantA.variant_id, quantity: 2 }] });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toMatch(/two lines/);

    await api().post(`/api/variants/${variantB.variant_id}/deactivate`);
    const hidden = await stockPo();
    expect(hidden.status).toBe(400);
    expect(hidden.body.error).toMatch(/ZZP-L-BLK is hidden/);
    await api().post(`/api/variants/${variantB.variant_id}/activate`);
  });

  it('checks quantity, date and supplier in plain English', async () => {
    const badQty = await stockPo({ lines: [{ variant_id: variantA.variant_id, quantity: 0 }] });
    expect(badQty.body.error).toBe('The quantity must be a whole number, 1 or more.');
    const future = await stockPo({ order_date: '2999-01-01' });
    expect(future.body.error).toBe('The purchase date cannot be in the future.');
    const noSupplier = await stockPo({ supplier_id: undefined });
    expect(noSupplier.body.error).toBe('Please choose the supplier.');
  });

  it('creates a non-stock purchase with a typed total and no lines, and nothing to receive', async () => {
    const res = await api().post('/api/purchases').send({
      supplier_id: supplierId, order_date: today(), purchase_type: otherType, total: '250.50', notes: 'Labels',
    });
    expect(res.status).toBe(201);
    expect(res.body.purchase).toMatchObject({ total_amount: '250.50', receipt_status: 'No stock', lines: [] });

    const receive = await api().post(`/api/purchases/${res.body.purchase.id}/receive`).send({ all: true });
    expect(receive.status).toBe(400);
    expect(receive.body.error).toBe('This purchase has no stock to receive.');

    const withLines = await api().post('/api/purchases').send({
      supplier_id: supplierId, order_date: today(), purchase_type: otherType, total: '10',
      lines: [{ variant_id: variantA.variant_id, quantity: 1 }],
    });
    expect(withLines.status).toBe(400);
    const noTotal = await api().post('/api/purchases').send({ supplier_id: supplierId, order_date: today(), purchase_type: otherType });
    expect(noTotal.body.error).toBe('Please enter the total amount.');
  });
});

describe('receiving stock', () => {
  it('adds stock only when received, in parts, keeping counters and the ledger in agreement', async () => {
    const created = (await stockPo()).body.purchase;
    const [lineA, lineB] = created.lines;

    const part = await api().post(`/api/purchases/${created.id}/receive`).send({ lines: [{ item_id: lineA.item_id, quantity: 2 }] });
    expect(part.status).toBe(200);
    expect(part.body.received_pieces).toBe(2);
    expect(part.body.purchase.receipt_status).toBe('Partly received');
    expect(await onHand(variantA)).toBe(2);

    const over = await api().post(`/api/purchases/${created.id}/receive`).send({ lines: [{ item_id: lineA.item_id, quantity: 4 }] });
    expect(over.status).toBe(400);
    expect(over.body.error).toBe('Only 3 still to receive on ZZP-M-BLK.');
    expect(await onHand(variantA)).toBe(2); // refused, nothing changed

    const rest = await api().post(`/api/purchases/${created.id}/receive`).send({ all: true });
    expect(rest.body.received_pieces).toBe(3 + 3);
    expect(rest.body.purchase.receipt_status).toBe('Received');
    expect(await onHand(variantA)).toBe(5);
    expect(await onHand(variantB)).toBe(3);

    const again = await api().post(`/api/purchases/${created.id}/receive`).send({ all: true });
    expect(again.body.error).toBe('Nothing is left to receive on this purchase.');

    // the counter on each line equals the sum of its receipt movements
    const check = await query(
      `SELECT i.qty_received, COALESCE(SUM(m.quantity), 0)::int AS ledger
         FROM purchase_order_item i LEFT JOIN inventory_movement m
           ON m.purchase_order_item_id = i.purchase_order_item_id AND m.movement_type = 'Purchase Receipt'
        WHERE i.purchase_order_id = $1 GROUP BY i.purchase_order_item_id, i.qty_received`,
      [created.id],
      t.client,
    );
    for (const row of check.rows) expect(row.qty_received).toBe(row.ledger);

    const history = await api().get(`/api/inventory/${variantA.variant_id}/movements`);
    expect(history.body.movements.map((m) => [m.movement_type, m.quantity, m.reason])).toContainEqual([
      'Purchase Receipt', 3, `Received on ${created.code}`,
    ]);
  });

  it('refuses a line from another purchase', async () => {
    const one = (await stockPo()).body.purchase;
    const two = (await stockPo()).body.purchase;
    const res = await api().post(`/api/purchases/${one.id}/receive`).send({ lines: [{ item_id: two.lines[0].item_id, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not belong/);
  });
});

describe('payments to the supplier', () => {
  it('moves Unpaid -> Partial -> Paid, with TRAN_ codes, and refuses overpaying', async () => {
    const po = (await stockPo()).body.purchase; // total 1370.30
    const pay = (body) => api().post(`/api/purchases/${po.id}/payments`).send({ amount: '500', txn_date: today(), payment_method: method, ...body });

    const first = await pay({});
    expect(first.status).toBe(201);
    expect(first.body.purchase).toMatchObject({ paid: '500.00', balance: '870.30', payment_state: 'Partial' });
    expect(first.body.purchase.payments[0].code).toMatch(/^TRAN_\d{8}$/);
    const refusedOver = await pay({ amount: '99999' });
    expect(refusedOver.status).toBe(400); // a refused payment must not use up a TRAN_ number

    const over = await pay({ amount: '870.31' });
    expect(over.status).toBe(400);
    expect(over.body.error).toBe('The balance is only ₹870.30. Please enter that or less.');

    const last = await pay({ amount: '870.30', note: 'Final' });
    const [a, b] = last.body.purchase.payments.map((x) => Number(x.code.slice(5)));
    expect(b).toBe(a + 1); // consecutive: nothing skipped in between
    expect(last.body.purchase).toMatchObject({ paid: '1370.30', balance: '0.00', payment_state: 'Paid' });

    const more = await pay({ amount: '1' });
    expect(more.body.error).toBe('This purchase is already fully paid.');

    // the app's numbers match the database view exactly
    const view = await query('SELECT paid, balance, payment_state FROM purchase_order_summary WHERE purchase_order_id = $1', [po.id], t.client);
    expect(view.rows[0]).toMatchObject({ paid: '1370.30', balance: '0.00', payment_state: 'Paid' });
  });

  it('checks amount, date and method', async () => {
    const po = (await stockPo()).body.purchase;
    const pay = (body) => api().post(`/api/purchases/${po.id}/payments`).send({ amount: '10', txn_date: today(), payment_method: method, ...body });
    expect((await pay({ amount: '0' })).body.error).toMatch(/payment amount must be a number above 0/);
    expect((await pay({ amount: '10.555' })).status).toBe(400);
    expect((await pay({ txn_date: '2999-01-01' })).body.error).toBe('The payment date cannot be in the future.');
    expect((await pay({ payment_method: 'Barter' })).body.error).toBe('Please choose a valid payment method.');
  });
});

describe('editing a purchase', () => {
  const edit = (po, body) =>
    api().patch(`/api/purchases/${po.id}`).send({ supplier_id: supplierId, order_date: po.order_date, notes: null, ...body });
  const sameLines = (po, change = {}) =>
    po.lines.map((l, i) => ({ item_id: l.item_id, variant_id: l.variant_id, quantity: l.qty_ordered, ...(change[i] ?? {}) }));

  it('recalculates the total, and can add a line but not remove one', async () => {
    const po = (await stockPo()).body.purchase;
    const changed = await edit(po, { lines: sameLines(po, { 0: { quantity: 10 } }), notes: 'Corrected' });
    expect(changed.status).toBe(200);
    expect(changed.body.purchase.total_amount).toBe('1870.30'); // 10 x 100 + 3 x 290.10
    expect(changed.body.purchase.notes).toBe('Corrected');

    const removed = await edit(po, { lines: sameLines(po).slice(0, 1) });
    expect(removed.status).toBe(400);
    expect(removed.body.error).toMatch(/can't be removed/);
  });

  it('locks product and cost once received, and never goes below what was received', async () => {
    const po = (await stockPo()).body.purchase;
    await api().post(`/api/purchases/${po.id}/receive`).send({ lines: [{ item_id: po.lines[0].item_id, quantity: 4 }] });

    const lower = await edit(po, { lines: sameLines(po, { 0: { quantity: 3 } }) });
    expect(lower.body.error).toBe("ZZP-M-BLK: 4 already received, so the quantity can't be lower than that.");
    const newCost = await edit(po, { lines: sameLines(po, { 0: { unit_cost: '120.00' } }) });
    expect(newCost.body.error).toMatch(/already been received/);
    const swapped = await edit(po, { lines: sameLines(po, { 0: { variant_id: variantB.variant_id } }) });
    expect(swapped.status).toBe(400);

    const ok = await edit(po, { lines: sameLines(po, { 0: { quantity: 4 } }) });
    expect(ok.status).toBe(200);
    expect(ok.body.purchase.total_amount).toBe('1270.30');
  });

  it('refuses a total lower than what is already paid, and keeps non-stock totals editable', async () => {
    const po = (await stockPo()).body.purchase;
    await api().post(`/api/purchases/${po.id}/payments`).send({ amount: '1000', txn_date: today(), payment_method: method });
    const tooLow = await edit(po, { lines: sameLines(po, { 0: { quantity: 1 } }) }); // new total 100 + 870.30 = 970.30
    expect(tooLow.status).toBe(400);
    expect(tooLow.body.error).toBe("The total can't be less than the 1000.00 already paid.");

    const labels = (await api().post('/api/purchases').send({ supplier_id: supplierId, order_date: today(), purchase_type: otherType, total: '100' })).body.purchase;
    const fixed = await edit(labels, { total: '120.50' });
    expect(fixed.body.purchase.total_amount).toBe('120.50');
    expect(fixed.body.purchase.purchase_type).toBe(otherType); // the type never changes
  });
});

describe('list and existing data', () => {
  it('lists purchases with filters and totals', async () => {
    const po = (await stockPo()).body.purchase;
    const found = await api().get('/api/purchases').query({ search: po.code });
    expect(found.body.purchases.map((p) => p.id)).toEqual([po.id]);
    const unpaid = await api().get('/api/purchases').query({ search: po.code, payment: 'Paid' });
    expect(unpaid.body.purchases).toEqual([]);
    expect(found.body.totals.owed).toMatch(/^\d+\.\d{2}$/);
    expect(Number.isInteger(found.body.totals.awaiting_receipt)).toBe(true);
  });

  it('keeps the old purchases consistent: stock purchase totals equal the sum of their lines, and nothing is over-received', async () => {
    const totals = await query(
      `SELECT po.po_code, po.total_amount, SUM(i.qty_ordered * i.unit_cost) AS lines_total
         FROM purchase_order po JOIN purchase_order_item i USING (purchase_order_id)
        WHERE po.po_code IN ('PO_0000001', 'PO_0000005')
        GROUP BY po.po_code, po.total_amount`,
      [],
      t.client,
    );
    for (const row of totals.rows) expect(row.lines_total).toBe(row.total_amount);
    const bad = await query('SELECT 1 FROM purchase_order_item WHERE qty_received > qty_ordered', [], t.client);
    expect(bad.rowCount).toBe(0);
  });
});
