// Shipping: send parcels, mark them In Transit / Delivered, and see what is ready to ship and what to buy.
// Stock leaves ONLY through the database function ship_items (atomic): this file never writes stock movements itself.
// Dates are always the India date (the database's own "today" is UTC and is "yesterday" for the first hours of the day).
import { Router } from 'express';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { getDb, inTransaction } from '../db.js';
import { UserError } from '../errors.js';
import { formatMoney } from '../money.js';
import { dateField, moneyField, optionalText, quantity, todayInIndia, uuid } from '../validation.js';

export const shipmentsRouter = Router();

const OPEN_STATUSES = ['Pending', 'Partially Shipped'];

// ---------- input checks ----------
const createSchema = z.object({
  lines: z
    .array(z.object({ order_item_id: uuid('Please choose the items to ship.'), quantity }), { required_error: 'Please choose at least one item to ship.' })
    .min(1, 'Please choose at least one item to ship.')
    .max(200, 'Too many lines in one parcel.'),
  courier_id: uuid('Please choose the courier.'),
  shipped_on: dateField('ship date').optional(),
  courier_cost: moneyField('courier cost', { positive: false }).optional(),
  shipping_charge: moneyField('shipping charge', { positive: false }).optional(),
  tracking_number: optionalText(60, 'tracking number'),
  bill_order_id: z.union([z.string().uuid('Please choose the order that carries the shipping charge.'), z.literal(''), z.null()]).optional().transform((v) => v || null),
});

const statusSchema = z.object({
  status: z.enum(['In Transit', 'Delivered'], { errorMap: () => ({ message: 'Please choose In Transit or Delivered.' }) }),
  delivered_on: dateField('delivery date').optional(),
});

const patchSchema = z.object({
  tracking_number: optionalText(60, 'tracking number'),
  note: optionalText(300, 'note'),
  courier_cost: moneyField('courier cost', { positive: false }).optional(),
  shipping_charge: moneyField('shipping charge', { positive: false }).optional(),
});

const idParam = (req) => uuid('That parcel was not found.').parse(req.params.id);

// ---------- reading ----------
const MONEY = ['courier_cost', 'shipping_charged', 'shipping_margin'];
const presentMoney = (row) => {
  const out = { ...row };
  for (const key of MONEY) if (key in out) out[key] = formatMoney(out[key]);
  return out;
};

async function fetchShipment(db, id) {
  const head = await db.query(
    `SELECT s.shipment_id AS id, s.shipment_code AS code, cr.name AS courier, s.tracking_number, s.shipment_status AS status,
            to_char(s.shipped_on, 'YYYY-MM-DD') AS shipped_on, to_char(s.delivered_on, 'YYYY-MM-DD') AS delivered_on,
            s.courier_cost, s.shipping_charged, (s.shipping_charged - s.courier_cost) AS shipping_margin, s.note,
            (s.courier_settlement_id IS NOT NULL) AS paid_to_courier, cs.settlement_code,
            bo.order_id AS billed_order_id, bo.order_code AS billed_order
       FROM shipment s
       JOIN supplier cr ON cr.supplier_id = s.courier_supplier_id
       JOIN customer_order bo ON bo.order_id = s.billed_order_id
       LEFT JOIN courier_settlement cs ON cs.settlement_id = s.courier_settlement_id
      WHERE s.shipment_id = $1`,
    [id],
  );
  if (head.rowCount === 0) return null;
  const lines = await db.query(
    `SELECT o.order_id, o.order_code, i.line_no, v.sku, p.name AS product_name, v.fabric, v.size, v.colour, si.quantity
       FROM shipment_item si
       JOIN order_item i ON i.order_item_id = si.order_item_id
       JOIN customer_order o ON o.order_id = i.order_id
       JOIN product_variant v ON v.variant_id = i.variant_id
       JOIN product p ON p.product_id = v.product_id
      WHERE si.shipment_id = $1 ORDER BY o.order_code, i.line_no`,
    [id],
  );
  const customers = await db.query(
    `SELECT DISTINCT c.name FROM shipment_item si
       JOIN order_item i ON i.order_item_id = si.order_item_id
       JOIN customer_order o ON o.order_id = i.order_id
       LEFT JOIN customer c ON c.customer_id = o.customer_id
      WHERE si.shipment_id = $1`,
    [id],
  );
  return {
    ...presentMoney(head.rows[0]),
    customers: customers.rows.map((c) => c.name || 'Walk-in customer'),
    lines: lines.rows,
    units: lines.rows.reduce((sum, l) => sum + l.quantity, 0),
  };
}

// Orders that could ship something right now.
shipmentsRouter.get('/ready', async (req, res, next) => {
  try {
    const { rows } = await getDb(req).query(
      `SELECT o.order_id AS id, o.order_code AS code, COALESCE(c.name, 'Walk-in customer') AS customer_name,
              to_char(o.order_date, 'YYYY-MM-DD') AS order_date, o.status,
              SUM(f.can_ship_now)::int AS ready_units, SUM(f.remaining)::int AS remaining_units,
              SUM(f.short_on_this_line)::int AS short_units
         FROM order_fulfilment f
         JOIN customer_order o ON o.order_id = f.order_id
         LEFT JOIN customer c ON c.customer_id = o.customer_id
        WHERE o.status IN ('Pending', 'Partially Shipped') AND f.remaining > 0
        GROUP BY o.order_id, o.order_code, c.name, o.order_date, o.status
       HAVING SUM(f.can_ship_now) > 0
        ORDER BY o.order_date, o.order_code`,
    );
    res.json({ orders: rows });
  } catch (err) {
    next(err);
  }
});

// What to buy so that waiting orders can be completed.
shipmentsRouter.get('/to-buy', async (req, res, next) => {
  try {
    const { rows } = await getDb(req).query('SELECT sku, product, units_waiting, on_hand, units_to_buy FROM purchase_needed ORDER BY units_to_buy DESC, sku');
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

// Everything the ship dialog needs: this order's open lines, the same customer's other open orders, the couriers.
shipmentsRouter.get('/candidates', async (req, res, next) => {
  try {
    const orderId = uuid('Please choose the order to ship.').parse(req.query.order_id);
    const db = getDb(req);
    const order = await db.query(
      `SELECT o.order_id AS id, o.order_code AS code, o.customer_id, COALESCE(c.name, 'Walk-in customer') AS customer_name, o.status
         FROM customer_order o LEFT JOIN customer c ON c.customer_id = o.customer_id WHERE o.order_id = $1`,
      [orderId],
    );
    if (order.rowCount === 0) throw new UserError('That order was not found.', 404);
    const o = order.rows[0];
    const lines = await db.query(
      `SELECT f.order_id, f.order_code, to_char(co.order_date, 'YYYY-MM-DD') AS order_date, f.order_item_id, f.line_no,
              f.sku, f.product, f.ordered, f.shipped, f.remaining, f.on_hand, f.can_ship_now, f.short_on_this_line AS short,
              (f.order_id = $1) AS this_order
         FROM order_fulfilment f
         JOIN customer_order co ON co.order_id = f.order_id
        WHERE f.remaining > 0 AND co.status IN ('Pending', 'Partially Shipped')
          AND (f.order_id = $1 OR ($2::uuid IS NOT NULL AND co.customer_id = $2))
        ORDER BY (f.order_id = $1) DESC, co.order_date, f.order_code, f.line_no`,
      [orderId, o.customer_id],
    );
    const couriers = await db.query('SELECT supplier_id AS id, supplier_code AS code, name FROM supplier WHERE is_active ORDER BY lower(name)');
    const last = await db.query('SELECT courier_supplier_id FROM shipment ORDER BY shipped_on DESC, shipment_code DESC LIMIT 1');
    res.json({
      order: { id: o.id, code: o.code, customer_name: o.customer_name, status: o.status, can_ship: OPEN_STATUSES.includes(o.status) },
      lines: lines.rows,
      couriers: couriers.rows,
      default_courier_id: last.rows[0]?.courier_supplier_id ?? null,
      today: todayInIndia(),
    });
  } catch (err) {
    next(err);
  }
});

const listQuery = z.object({
  search: z.string().trim().max(80).optional(),
  status: z.enum(['Shipped', 'In Transit', 'Delivered']).optional(),
  courier_payment: z.enum(['Unpaid', 'Paid']).optional(),
});

shipmentsRouter.get('/', async (req, res, next) => {
  try {
    const q = listQuery.parse(Object.fromEntries(Object.entries(req.query).filter(([, value]) => value !== '')));
    const db = getDb(req);
    const { rows } = await db.query(
      `SELECT * FROM (
         SELECT s.shipment_id AS id, s.shipment_code AS code, cr.name AS courier, s.tracking_number, s.shipment_status AS status,
                to_char(s.shipped_on, 'YYYY-MM-DD') AS shipped_on, to_char(s.delivered_on, 'YYYY-MM-DD') AS delivered_on,
                s.courier_cost, s.shipping_charged, (s.courier_settlement_id IS NOT NULL) AS paid_to_courier,
                ord.units, ord.orders, ord.order_codes, ord.customers
           FROM shipment s
           JOIN supplier cr ON cr.supplier_id = s.courier_supplier_id
           LEFT JOIN LATERAL (
             SELECT SUM(si.quantity)::int AS units,
                    jsonb_agg(DISTINCT jsonb_build_object('id', o.order_id, 'code', o.order_code)) AS orders,
                    string_agg(DISTINCT o.order_code, ' ') AS order_codes,
                    string_agg(DISTINCT COALESCE(c.name, 'Walk-in customer'), ', ') AS customers
               FROM shipment_item si
               JOIN order_item i ON i.order_item_id = si.order_item_id
               JOIN customer_order o ON o.order_id = i.order_id
               LEFT JOIN customer c ON c.customer_id = o.customer_id
              WHERE si.shipment_id = s.shipment_id) ord ON true
       ) x
        WHERE ($1::text IS NULL OR strpos(lower(x.code), lower($1)) > 0 OR strpos(lower(COALESCE(x.tracking_number, '')), lower($1)) > 0
               OR strpos(lower(COALESCE(x.order_codes, '')), lower($1)) > 0 OR strpos(lower(COALESCE(x.customers, '')), lower($1)) > 0)
          AND ($2::text IS NULL OR x.status = $2)
          AND ($3::text IS NULL OR (CASE WHEN x.paid_to_courier THEN 'Paid' ELSE 'Unpaid' END) = $3)
        ORDER BY x.shipped_on DESC, x.code DESC`,
      [q.search ?? null, q.status ?? null, q.courier_payment ?? null],
    );
    const totals = await db.query(
      `SELECT COUNT(*) FILTER (WHERE shipment_status <> 'Delivered')::int AS on_the_way,
              COALESCE(SUM(courier_cost) FILTER (WHERE courier_settlement_id IS NULL), 0) AS courier_unpaid
         FROM shipment`,
    );
    res.json({
      shipments: rows.map(presentMoney),
      totals: { on_the_way: totals.rows[0].on_the_way, courier_unpaid: formatMoney(totals.rows[0].courier_unpaid) },
    });
  } catch (err) {
    next(err);
  }
});

shipmentsRouter.get('/:id', async (req, res, next) => {
  try {
    const shipment = await fetchShipment(getDb(req), idParam(req));
    if (!shipment) throw new UserError('That parcel was not found.', 404);
    res.json({ shipment });
  } catch (err) {
    next(err);
  }
});

// ---------- send a parcel ----------
// If the database ever refuses a shipment for a reason we did not catch first, say it in plain English.
function friendlyShipError(err) {
  const text = err?.message || '';
  if (/Insufficient stock/i.test(text)) return new UserError('Not enough stock for one of the items. Please refresh and check what is in stock.', 409);
  if (/Cannot ship \d+ units/i.test(text)) return new UserError('One of the lines has less left to ship than you entered. Please refresh and try again.', 409);
  if (/only carry items for one customer/i.test(text)) return new UserError('A parcel can only carry items for one customer.', 400);
  if (/cannot be shipped/i.test(text)) return new UserError('One of the orders has already been fully shipped.', 409);
  if (/before order date/i.test(text)) return new UserError("The ship date can't be before the order date.", 400);
  return err;
}

shipmentsRouter.post('/', async (req, res, next) => {
  try {
    const v = createSchema.parse(req.body);
    const shippedOn = v.shipped_on ?? todayInIndia();
    const courierCost = v.courier_cost ?? new Decimal(0);
    const charge = v.shipping_charge ?? new Decimal(0);

    const id = await inTransaction(req, async (db) => {
      const ids = v.lines.map((l) => l.order_item_id);
      if (new Set(ids).size !== ids.length) throw new UserError('The same line is listed twice.', 400);

      // lock the orders involved so the checks below stay true until the parcel is saved
      const items = (await db.query(
        `SELECT i.order_item_id AS id, i.order_id, i.quantity AS ordered, i.variant_id, v.sku, o.order_code, o.status,
                o.customer_id, to_char(o.order_date, 'YYYY-MM-DD') AS order_date, COALESCE(x.q, 0)::int AS shipped,
                COALESCE(b.on_hand, 0)::int AS on_hand
           FROM order_item i
           JOIN product_variant v ON v.variant_id = i.variant_id
           JOIN customer_order o ON o.order_id = i.order_id
           LEFT JOIN inventory_balance b ON b.variant_id = i.variant_id
           LEFT JOIN LATERAL (SELECT SUM(quantity) AS q FROM shipment_item si WHERE si.order_item_id = i.order_item_id) x ON true
          WHERE i.order_item_id = ANY($1::uuid[])
          ORDER BY o.order_code FOR UPDATE OF o`,
        [ids],
      )).rows;
      const byId = new Map(items.map((i) => [i.id, i]));
      for (const id of ids) if (!byId.has(id)) throw new UserError('One of the items to ship was not found. Please refresh and try again.', 400);

      // orders still open, nothing over what is left, one customer
      for (const i of items) {
        if (!OPEN_STATUSES.includes(i.status)) throw new UserError(`${i.order_code} has already been fully shipped.`, 400);
      }
      const asked = v.lines.map((l) => ({ ...byId.get(l.order_item_id), qty: l.quantity }));
      for (const l of asked) {
        const left = l.ordered - l.shipped;
        if (l.qty > left) throw new UserError(`Only ${left} left to ship on ${l.sku} (${l.order_code}).`, 400);
      }
      const orders = [...new Map(asked.map((l) => [l.order_id, l])).values()];
      if (orders.length > 1) {
        if (orders.some((o) => !o.customer_id)) throw new UserError('Walk-in orders cannot be combined with other orders in one parcel.', 400);
        if (new Set(orders.map((o) => o.customer_id)).size > 1) throw new UserError('A parcel can only carry items for one customer.', 400);
      }

      // stock: all lines of the same product share what is on the shelf
      const perVariant = new Map();
      for (const l of asked) {
        const entry = perVariant.get(l.variant_id) ?? { sku: l.sku, need: 0, onHand: l.on_hand };
        entry.need += l.qty;
        perVariant.set(l.variant_id, entry);
      }
      for (const { sku, need, onHand } of perVariant.values()) {
        if (need > onHand) throw new UserError(`Not enough stock for ${sku}: only ${onHand} in stock.`, 400);
      }

      // dates, courier, billed order
      for (const o of orders) {
        if (shippedOn < o.order_date) throw new UserError(`The ship date can't be before the order date (${o.order_date}) of ${o.order_code}.`, 400);
      }
      const courier = await db.query('SELECT is_active FROM supplier WHERE supplier_id = $1', [v.courier_id]);
      if (courier.rowCount === 0) throw new UserError('That courier was not found.', 400);
      let billed = v.bill_order_id;
      if (billed && !orders.some((o) => o.order_id === billed)) {
        throw new UserError('The shipping charge must be billed on one of the orders in this parcel.', 400);
      }
      if (!billed) {
        billed = [...orders].sort((a, b) => (a.order_date + a.order_code).localeCompare(b.order_date + b.order_code))[0].order_id;
      }

      const shipped = await db.query(
        'SELECT ship_items($1::jsonb, $2, $3::date, $4, $5, $6, $7, $8) AS id',
        [
          JSON.stringify(v.lines.map((l) => ({ order_item_id: l.order_item_id, quantity: l.quantity }))),
          v.courier_id, shippedOn, courierCost.toFixed(2), v.tracking_number, req.user.name, charge.toFixed(2), billed,
        ],
      ).catch((err) => {
        throw friendlyShipError(err);
      });
      return shipped.rows[0].id;
    });
    res.status(201).json({ shipment: await fetchShipment(getDb(req), id) });
  } catch (err) {
    next(err);
  }
});

// ---------- parcel status ----------
shipmentsRouter.post('/:id/status', async (req, res, next) => {
  try {
    const id = idParam(req);
    const v = statusSchema.parse(req.body);
    await inTransaction(req, async (db) => {
      const found = await db.query(
        `SELECT shipment_status, to_char(shipped_on, 'YYYY-MM-DD') AS shipped_on FROM shipment WHERE shipment_id = $1 FOR UPDATE`,
        [id],
      );
      if (found.rowCount === 0) throw new UserError('That parcel was not found.', 404);
      const { shipment_status: current, shipped_on: shippedOn } = found.rows[0];
      if (current === 'Delivered') throw new UserError('This parcel is already delivered, and that cannot be undone.', 400);
      if (v.status === 'In Transit') {
        if (current !== 'Shipped') throw new UserError('This parcel is already in transit.', 400);
        await db.query("UPDATE shipment SET shipment_status = 'In Transit' WHERE shipment_id = $1", [id]);
        return;
      }
      const deliveredOn = v.delivered_on ?? todayInIndia();
      if (deliveredOn < shippedOn) throw new UserError(`The delivery date can't be before the ship date (${shippedOn}).`, 400);
      // the database marks each order Delivered once all of its parcels are
      await db.query("UPDATE shipment SET shipment_status = 'Delivered', delivered_on = $2 WHERE shipment_id = $1", [id, deliveredOn]);
    });
    res.json({ shipment: await fetchShipment(getDb(req), id) });
  } catch (err) {
    next(err);
  }
});

// ---------- fix details ----------
shipmentsRouter.patch('/:id', async (req, res, next) => {
  try {
    const id = idParam(req);
    const v = patchSchema.parse(req.body);
    const has = (key) => Object.prototype.hasOwnProperty.call(req.body ?? {}, key);
    if ((has('courier_cost') || has('shipping_charge')) && req.user.role !== 'owner') {
      throw new UserError('Only the owner can change the courier cost or the shipping charge.', 403);
    }
    await inTransaction(req, async (db) => {
      const found = await db.query('SELECT courier_cost, courier_settlement_id FROM shipment WHERE shipment_id = $1 FOR UPDATE', [id]);
      if (found.rowCount === 0) throw new UserError('That parcel was not found.', 404);
      if (has('courier_cost') && found.rows[0].courier_settlement_id && !v.courier_cost.equals(found.rows[0].courier_cost)) {
        throw new UserError("This parcel has already been paid to the courier, so its courier cost can't change.", 400);
      }
      const sets = [];
      const params = [id];
      const add = (column, value) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (has('tracking_number')) add('tracking_number', v.tracking_number);
      if (has('note')) add('note', v.note);
      if (has('courier_cost')) add('courier_cost', v.courier_cost.toFixed(2));
      if (has('shipping_charge')) add('shipping_charged', v.shipping_charge.toFixed(2));
      if (sets.length === 0) throw new UserError('Nothing to change.', 400);
      await db.query(`UPDATE shipment SET ${sets.join(', ')} WHERE shipment_id = $1`, params);
    });
    res.json({ shipment: await fetchShipment(getDb(req), id) });
  } catch (err) {
    next(err);
  }
});
