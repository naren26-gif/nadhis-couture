// Orders: customer orders with several lines, pricing and discounts, and payments received from the customer.
// Shipping is separate (it goes through the ship_* database functions). Stock does NOT move when an order is placed.
// Money is Decimal / "450.00" strings; totals are always computed here from the lines, never taken from the browser.
// The cost of each line (unit_cost_snapshot) always comes from the product master on the server.
import { Router } from 'express';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { getDb, inTransaction } from '../db.js';
import { nextCode } from '../codes.js';
import { UserError } from '../errors.js';
import { formatMoney } from '../money.js';
import { dateField, moneyField, optionalText, quantity, uuid } from '../validation.js';

export const ordersRouter = Router();

const MAX_TOTAL = new Decimal('9999999.99');
const EDITABLE_STATUSES = ['Pending', 'Partially Shipped'];

// ---------- input checks ----------
const customerField = z
  .union([z.string().uuid('Please choose a valid customer.'), z.literal(''), z.null()])
  .optional()
  .transform((value) => value || null);

const lineSchema = z.object({
  item_id: z.string().uuid().optional(), // present when editing an existing line
  variant_id: uuid('Please choose the product for every line.'),
  quantity,
  unit_price: moneyField('unit price', { positive: false }).optional(),
  discount: moneyField('discount', { positive: false }).optional(),
});

const orderSchema = z.object({
  customer_id: customerField,
  order_date: dateField('order date'),
  notes: optionalText(500, 'notes'),
  lines: z
    .array(lineSchema, { required_error: 'Please add at least one product line.' })
    .min(1, 'Please add at least one product line.')
    .max(200, 'Too many lines in one order.'),
});

const paymentSchema = z.object({
  amount: moneyField('payment amount', { positive: true }),
  txn_date: dateField('payment date'),
  payment_method: z.string({ required_error: 'Please choose how it was paid.' }).trim().min(1, 'Please choose how it was paid.'),
  note: optionalText(300, 'note'),
  confirm_advance: z.boolean().optional(),
});

// A refund repays money a customer paid BEYOND what the order is worth. It is not a cancellation and never refunds goods.
const refundSchema = z.object({
  amount: moneyField('refund amount', { positive: true }),
  txn_date: dateField('refund date'),
  payment_method: z.string({ required_error: 'Please choose how it was paid back.' }).trim().min(1, 'Please choose how it was paid back.'),
  reason: z
    .string({ required_error: 'Please give a reason for the refund.' })
    .trim()
    .min(3, 'Please give a reason for the refund (at least 3 letters).')
    .max(300, 'The reason is too long (300 characters at most).'),
});

const idParam = (req) => uuid('That order was not found.').parse(req.params.id);

// ---------- reading ----------
const BASE_SELECT = `
  SELECT os.order_id AS id, os.order_code AS code, o.customer_id, os.customer AS customer_name, c.phone AS customer_phone,
         to_char(os.order_date, 'YYYY-MM-DD') AS order_date, os.status, o.notes,
         os.ordered_qty, os.shipped_qty, os.items_total, os.shipping_charged, os.order_total,
         os.received, os.balance, os.payment_state, os.product_cost, os.profit, os.paid_in, os.refunded,
         GREATEST(os.received - os.order_total, 0) AS credit_held,
         (os.status IN ('Pending', 'Partially Shipped')) AS editable,
         EXISTS (SELECT 1 FROM order_fulfilment f
                  WHERE f.order_id = os.order_id AND f.remaining > 0 AND f.short_on_this_line > 0
                    AND os.status IN ('Pending', 'Partially Shipped')) AS waiting_for_stock
    FROM order_summary os
    JOIN customer_order o ON o.order_id = os.order_id
    LEFT JOIN customer c ON c.customer_id = o.customer_id`;

const MONEY_COLUMNS = [
  'items_total', 'shipping_charged', 'order_total', 'received', 'balance', 'product_cost', 'profit', 'paid_in', 'refunded', 'credit_held',
];
function present(row) {
  const out = { ...row };
  for (const column of MONEY_COLUMNS) out[column] = formatMoney(row[column]);
  return out;
}

async function fetchOrder(db, id) {
  const head = await db.query(`${BASE_SELECT} WHERE os.order_id = $1`, [id]);
  if (head.rowCount === 0) return null;
  const lines = await db.query(
    `SELECT i.order_item_id AS item_id, i.line_no, i.variant_id, v.sku, p.name AS product_name,
            v.fabric, v.size, v.colour, v.is_active, i.quantity, COALESCE(x.q, 0)::int AS shipped,
            (i.quantity - COALESCE(x.q, 0))::int AS remaining, b.on_hand, v.list_price,
            i.unit_price, i.discount, i.unit_cost_snapshot, (i.quantity * i.unit_price - i.discount) AS line_total
       FROM order_item i
       JOIN product_variant v ON v.variant_id = i.variant_id
       JOIN product p ON p.product_id = v.product_id
       JOIN inventory_balance b ON b.variant_id = v.variant_id
       LEFT JOIN LATERAL (SELECT SUM(quantity) AS q FROM shipment_item si WHERE si.order_item_id = i.order_item_id) x ON true
      WHERE i.order_id = $1 ORDER BY i.line_no`,
    [id],
  );
  const parcels = await db.query(
    `SELECT s.shipment_id AS id, s.shipment_code AS code, s.shipment_status AS status, to_char(s.shipped_on, 'YYYY-MM-DD') AS shipped_on,
            s.tracking_number, s.shipping_charged, (s.billed_order_id = $1) AS billed_here, SUM(si.quantity)::int AS units_here
       FROM shipment s
       JOIN shipment_item si ON si.shipment_id = s.shipment_id
       JOIN order_item i ON i.order_item_id = si.order_item_id
      WHERE i.order_id = $1
      GROUP BY s.shipment_id, s.shipment_code, s.shipment_status, s.shipped_on, s.tracking_number, s.shipping_charged, s.billed_order_id
      ORDER BY s.shipped_on, s.shipment_code`,
    [id],
  );
  const payments = await db.query(
    `SELECT transaction_id, transaction_code AS code, to_char(txn_date, 'YYYY-MM-DD') AS txn_date, amount, direction,
            payment_method, payment_status, note, is_migration_adjustment
       FROM payment_transaction WHERE order_id = $1 ORDER BY txn_date, created_at`,
    [id],
  );
  return {
    ...present(head.rows[0]),
    lines: lines.rows.map((l) => ({
      ...l,
      list_price: formatMoney(l.list_price),
      unit_price: formatMoney(l.unit_price),
      discount: formatMoney(l.discount),
      unit_cost_snapshot: formatMoney(l.unit_cost_snapshot),
      line_total: formatMoney(l.line_total),
    })),
    parcels: parcels.rows.map((p) => ({ ...p, shipping_charged: formatMoney(p.shipping_charged) })),
    payments: payments.rows.map((p) => ({ ...p, amount: formatMoney(p.amount) })),
  };
}

// Dropdown contents for the order screens. (Declared before '/:id'.)
ordersRouter.get('/lookups', async (req, res, next) => {
  try {
    const db = getDb(req);
    const customers = await db.query('SELECT customer_id AS id, customer_code AS code, name, phone FROM customer WHERE is_active ORDER BY lower(name), customer_code');
    const methods = await db.query('SELECT name FROM payment_method_ref ORDER BY name');
    res.json({ customers: customers.rows, methods: methods.rows.map((m) => m.name) });
  } catch (err) {
    next(err);
  }
});

const listQuery = z.object({
  search: z.string().trim().max(80).optional(),
  customer: z.string().uuid().optional(),
  status: z.enum(['Pending', 'Partially Shipped', 'Shipped', 'Delivered']).optional(),
  payment: z.enum(['Unpaid', 'Partial', 'Paid', 'Advance', 'Overpaid']).optional(),
  waiting: z.enum(['true']).optional(),
  credit: z.enum(['true']).optional(), // only orders where the customer has paid more than the order is worth
});

ordersRouter.get('/', async (req, res, next) => {
  try {
    const q = listQuery.parse(Object.fromEntries(Object.entries(req.query).filter(([, value]) => value !== '')));
    const db = getDb(req);
    const { rows } = await db.query(
      `SELECT * FROM (${BASE_SELECT}) x
        WHERE ($1::text IS NULL OR strpos(lower(x.code), lower($1)) > 0 OR strpos(lower(COALESCE(x.customer_name, '')), lower($1)) > 0
               OR strpos(COALESCE(x.customer_phone, ''), $1) > 0 OR strpos(lower(COALESCE(x.notes, '')), lower($1)) > 0)
          AND ($2::uuid IS NULL OR x.customer_id = $2)
          AND ($3::text IS NULL OR x.status = $3)
          AND ($4::text IS NULL OR x.payment_state = $4)
          AND ($5::boolean IS NULL OR x.waiting_for_stock = $5)
          AND ($6::boolean IS NULL OR (x.credit_held > 0) = $6)
        ORDER BY x.order_date DESC, x.code DESC`,
      [q.search ?? null, q.customer ?? null, q.status ?? null, q.payment ?? null, q.waiting ? true : null, q.credit ? true : null],
    );
    const totals = await db.query(
      `SELECT COALESCE(SUM(balance) FILTER (WHERE balance > 0), 0) AS to_collect,
              COALESCE(SUM(-balance) FILTER (WHERE balance < 0), 0) AS credit_held,
              COUNT(*) FILTER (WHERE balance < 0)::int AS credit_orders,
              COUNT(*) FILTER (WHERE status IN ('Pending', 'Partially Shipped'))::int AS open_orders
         FROM order_summary`,
    );
    const waiting = await db.query(`SELECT COUNT(*)::int AS n FROM (${BASE_SELECT}) x WHERE x.waiting_for_stock`);
    res.json({
      orders: rows.map(present),
      totals: {
        to_collect: formatMoney(totals.rows[0].to_collect),
        credit_held: formatMoney(totals.rows[0].credit_held),
        credit_orders: totals.rows[0].credit_orders,
        open_orders: totals.rows[0].open_orders,
        waiting_for_stock: waiting.rows[0].n,
      },
    });
  } catch (err) {
    next(err);
  }
});

ordersRouter.get('/:id', async (req, res, next) => {
  try {
    const order = await fetchOrder(getDb(req), idParam(req));
    if (!order) throw new UserError('That order was not found.', 404);
    res.json({ order });
  } catch (err) {
    next(err);
  }
});

// ---------- shared checks ----------
async function checkCustomer(db, customerId) {
  if (!customerId) return; // a guest (walk-in) order has no customer
  const { rows } = await db.query('SELECT is_active FROM customer WHERE customer_id = $1', [customerId]);
  if (rows.length === 0) throw new UserError('That customer was not found.', 400);
  if (!rows[0].is_active) throw new UserError('That customer is hidden. Please choose another customer.', 400);
}

async function loadVariants(db, variantIds) {
  const { rows } = await db.query(
    'SELECT variant_id, sku, list_price, unit_cost, is_active FROM product_variant WHERE variant_id = ANY($1::uuid[])',
    [variantIds],
  );
  const byId = new Map(rows.map((r) => [r.variant_id, r]));
  for (const id of variantIds) {
    if (!byId.has(id)) throw new UserError('One of the chosen products no longer exists. Please refresh and try again.', 400);
  }
  return byId;
}

function checkNoDuplicateVariants(lines) {
  const seen = new Set();
  for (const line of lines) {
    if (seen.has(line.variant_id)) throw new UserError('The same product is on two lines. Please combine them into one line.', 400);
    seen.add(line.variant_id);
  }
}

const lineValue = (qty, price) => new Decimal(price).times(qty);

function checkDiscount(sku, qty, price, discount) {
  const value = lineValue(qty, price);
  if (new Decimal(discount).gt(value)) {
    throw new UserError(`${sku}: the discount can't be more than the line total of ₹${value.toFixed(2)}.`, 400);
  }
}

const orderTotal = (lines) => lines.reduce((sum, l) => sum.plus(lineValue(l.quantity, l.unit_price)).minus(l.discount), new Decimal(0));

function checkTotal(total) {
  if (total.gt(MAX_TOTAL)) throw new UserError('That order total is too large.', 400);
}

// ---------- create ----------
ordersRouter.post('/', async (req, res, next) => {
  try {
    const v = orderSchema.parse(req.body);
    const id = await inTransaction(req, async (db) => {
      await checkCustomer(db, v.customer_id);
      checkNoDuplicateVariants(v.lines);
      const variants = await loadVariants(db, v.lines.map((l) => l.variant_id));
      const lines = v.lines.map((l) => {
        const variant = variants.get(l.variant_id);
        if (!variant.is_active) throw new UserError(`${variant.sku} is hidden. Show it again on the Products screen first.`, 400);
        const price = l.unit_price ?? new Decimal(variant.list_price);
        const discount = l.discount ?? new Decimal(0);
        checkDiscount(variant.sku, l.quantity, price, discount);
        // the cost of goods is ALWAYS the product master's current cost, whatever the browser sends
        return { variant_id: l.variant_id, quantity: l.quantity, unit_price: price, discount, cost: new Decimal(variant.unit_cost) };
      });
      checkTotal(orderTotal(lines));

      const code = await nextCode(db, { table: 'customer_order', column: 'order_code', prefix: 'SO_', width: 7 });
      const order = await db.query(
        `INSERT INTO customer_order (order_code, customer_id, order_date, notes) VALUES ($1, $2, $3, $4) RETURNING order_id`,
        [code, v.customer_id, v.order_date, v.notes],
      );
      const orderId = order.rows[0].order_id;
      let lineNo = 0;
      for (const l of lines) {
        lineNo += 1;
        await db.query(
          `INSERT INTO order_item (order_id, line_no, variant_id, quantity, unit_price, discount, unit_cost_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [orderId, lineNo, l.variant_id, l.quantity, l.unit_price.toFixed(2), l.discount.toFixed(2), l.cost.toFixed(2)],
        );
      }
      return orderId;
    });
    res.status(201).json({ order: await fetchOrder(getDb(req), id) });
  } catch (err) {
    next(err);
  }
});

// ---------- edit (only before it has shipped completely) ----------
ordersRouter.patch('/:id', async (req, res, next) => {
  try {
    const orderId = idParam(req);
    const v = orderSchema.parse(req.body);
    await inTransaction(req, async (db) => {
      const head = await db.query('SELECT status, customer_id FROM customer_order WHERE order_id = $1 FOR UPDATE', [orderId]);
      if (head.rowCount === 0) throw new UserError('That order was not found.', 404);
      if (!EDITABLE_STATUSES.includes(head.rows[0].status)) {
        throw new UserError(`This order is already ${head.rows[0].status.toLowerCase()}, so it can't be edited.`, 400);
      }
      if (v.customer_id !== head.rows[0].customer_id) await checkCustomer(db, v.customer_id);

      const existing = (await db.query(
        `SELECT i.order_item_id AS id, i.line_no, i.variant_id, i.quantity, i.unit_price, i.discount, i.unit_cost_snapshot,
                v.sku, COALESCE(x.q, 0)::int AS shipped
           FROM order_item i
           JOIN product_variant v ON v.variant_id = i.variant_id
           LEFT JOIN LATERAL (SELECT SUM(quantity) AS q FROM shipment_item si WHERE si.order_item_id = i.order_item_id) x ON true
          WHERE i.order_id = $1 ORDER BY i.line_no FOR UPDATE OF i`,
        [orderId],
      )).rows;
      const byId = new Map(existing.map((e) => [e.id, e]));
      checkNoDuplicateVariants(v.lines);
      const variants = await loadVariants(db, v.lines.map((l) => l.variant_id));

      // 1. work out every line first (nothing is written until all checks pass)
      const keep = [];
      const sentIds = new Set();
      for (const l of v.lines) {
        const variant = variants.get(l.variant_id);
        if (l.item_id) {
          const e = byId.get(l.item_id);
          if (!e) throw new UserError('One of the lines does not belong to this order. Please refresh and try again.', 400);
          sentIds.add(e.id);
          const same = e.variant_id === l.variant_id;
          const price = l.unit_price ?? (same ? new Decimal(e.unit_price) : new Decimal(variant.list_price));
          const discount = l.discount ?? (same ? new Decimal(e.discount) : new Decimal(0));
          if (e.shipped > 0) {
            if (!same || !price.equals(e.unit_price) || !discount.equals(e.discount)) {
              throw new UserError(`${e.sku} has already shipped, so its product, price and discount can't change.`, 400);
            }
            if (l.quantity < e.shipped) {
              throw new UserError(`${e.sku}: ${e.shipped} already shipped, so the quantity can't be lower than that.`, 400);
            }
          } else if (!same && !variant.is_active) {
            throw new UserError(`${variant.sku} is hidden. Show it again on the Products screen first.`, 400);
          }
          checkDiscount(variant.sku, l.quantity, price, discount);
          keep.push({ kind: 'update', id: e.id, variant_id: l.variant_id, quantity: l.quantity, unit_price: price, discount,
            cost: same ? new Decimal(e.unit_cost_snapshot) : new Decimal(variant.unit_cost) });
        } else {
          if (!variant.is_active) throw new UserError(`${variant.sku} is hidden. Show it again on the Products screen first.`, 400);
          const price = l.unit_price ?? new Decimal(variant.list_price);
          const discount = l.discount ?? new Decimal(0);
          checkDiscount(variant.sku, l.quantity, price, discount);
          keep.push({ kind: 'insert', variant_id: l.variant_id, quantity: l.quantity, unit_price: price, discount, cost: new Decimal(variant.unit_cost) });
        }
      }
      const removed = existing.filter((e) => !sentIds.has(e.id));
      for (const e of removed) {
        if (e.shipped > 0) throw new UserError(`${e.sku} has already shipped, so it can't be removed.`, 400);
      }
      checkTotal(orderTotal(keep));

      // 2. write: remove, update, add, then let the database re-work the order's shipping status
      for (const e of removed) await db.query('DELETE FROM order_item WHERE order_item_id = $1', [e.id]);
      let nextLine = existing.reduce((max, e) => Math.max(max, e.line_no), 0);
      for (const l of keep) {
        if (l.kind === 'update') {
          await db.query(
            `UPDATE order_item SET variant_id = $2, quantity = $3, unit_price = $4, discount = $5, unit_cost_snapshot = $6
              WHERE order_item_id = $1`,
            [l.id, l.variant_id, l.quantity, l.unit_price.toFixed(2), l.discount.toFixed(2), l.cost.toFixed(2)],
          );
        } else {
          nextLine += 1;
          await db.query(
            `INSERT INTO order_item (order_id, line_no, variant_id, quantity, unit_price, discount, unit_cost_snapshot)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [orderId, nextLine, l.variant_id, l.quantity, l.unit_price.toFixed(2), l.discount.toFixed(2), l.cost.toFixed(2)],
          );
        }
      }
      await db.query('UPDATE customer_order SET customer_id = $2, order_date = $3, notes = $4 WHERE order_id = $1', [
        orderId, v.customer_id, v.order_date, v.notes,
      ]);
      await db.query('SELECT refresh_order_shipping_status($1)', [orderId]);
    });
    res.json({ order: await fetchOrder(getDb(req), orderId) });
  } catch (err) {
    next(err);
  }
});

// ---------- refund a customer's overpayment ----------
ordersRouter.post('/:id/refunds', async (req, res, next) => {
  try {
    const orderId = idParam(req);
    const r = refundSchema.parse(req.body);
    await inTransaction(req, async (db) => {
      const locked = await db.query('SELECT 1 FROM customer_order WHERE order_id = $1 FOR UPDATE', [orderId]);
      if (locked.rowCount === 0) throw new UserError('That order was not found.', 404);

      const method = await db.query('SELECT 1 FROM payment_method_ref WHERE name = $1', [r.payment_method]);
      if (method.rowCount === 0) throw new UserError('Please choose a valid payment method.', 400);

      // only the surplus can go back: what has been received (net of earlier refunds) beyond what the order is worth
      const { rows } = await db.query('SELECT received, order_total FROM order_summary WHERE order_id = $1', [orderId]);
      const surplus = Decimal.max(new Decimal(rows[0].received).minus(rows[0].order_total), 0);
      if (surplus.lte(0)) throw new UserError('There is no overpaid amount to refund on this order.', 400);
      if (r.amount.gt(surplus)) {
        throw new UserError(`You can refund at most ₹${surplus.toFixed(2)}: what the customer has paid beyond this order.`, 400);
      }

      const code = await nextCode(db, { table: 'payment_transaction', column: 'transaction_code', prefix: 'TRAN_', width: 8 });
      await db.query(
        `INSERT INTO payment_transaction
           (transaction_code, txn_date, direction, amount, payment_method, payment_status, order_id, note)
         VALUES ($1, $2, 'Out', $3, $4, 'Completed', $5, $6)`,
        [code, r.txn_date, r.amount.toFixed(2), r.payment_method, orderId, r.reason],
      );
    });
    res.status(201).json({ order: await fetchOrder(getDb(req), orderId) });
  } catch (err) {
    next(err);
  }
});

// ---------- payments received from the customer ----------
ordersRouter.post('/:id/payments', async (req, res, next) => {
  try {
    const orderId = idParam(req);
    const p = paymentSchema.parse(req.body);
    await inTransaction(req, async (db) => {
      // lock the order so two people recording payments at once see each other's
      const locked = await db.query('SELECT 1 FROM customer_order WHERE order_id = $1 FOR UPDATE', [orderId]);
      if (locked.rowCount === 0) throw new UserError('That order was not found.', 404);

      const method = await db.query('SELECT 1 FROM payment_method_ref WHERE name = $1', [p.payment_method]);
      if (method.rowCount === 0) throw new UserError('Please choose a valid payment method.', 400);

      // Shipping is added per parcel later, so money can arrive in advance. There are no refunds, so a payment that is
      // more than what is owed right now must be confirmed.
      const { rows } = await db.query('SELECT balance FROM order_summary WHERE order_id = $1', [orderId]);
      const balance = new Decimal(rows[0].balance);
      if (!p.confirm_advance && p.amount.gt(Decimal.max(balance, 0))) {
        throw new UserError(
          balance.gt(0)
            ? `That is more than the balance of ₹${balance.toFixed(2)}. If the customer is paying in advance, confirm it to record the payment.`
            : 'This order is already fully paid. If the customer is paying in advance, confirm it to record the payment.',
          400,
        );
      }

      const code = await nextCode(db, { table: 'payment_transaction', column: 'transaction_code', prefix: 'TRAN_', width: 8 });
      await db.query(
        `INSERT INTO payment_transaction
           (transaction_code, txn_date, direction, amount, payment_method, payment_status, order_id, note)
         VALUES ($1, $2, 'In', $3, $4, 'Completed', $5, $6)`,
        [code, p.txn_date, p.amount.toFixed(2), p.payment_method, orderId, p.note],
      );
    });
    res.status(201).json({ order: await fetchOrder(getDb(req), orderId) });
  } catch (err) {
    next(err);
  }
});
