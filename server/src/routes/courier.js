// Courier month-end: the courier is paid ONE lump sum a month. A settlement records that payment and links the parcels it
// covers, so each parcel is "paid to courier". The database only REPORTS a mismatch afterwards (courier_settlement_summary),
// so this file makes sure the parcels belong to the chosen courier and month, and that any difference is explained.
import { Router } from 'express';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { getDb, inTransaction } from '../db.js';
import { nextCode } from '../codes.js';
import { UserError } from '../errors.js';
import { formatMoney } from '../money.js';
import { dateField, moneyField, optionalText, todayInIndia, uuid } from '../validation.js';

export const courierRouter = Router();

const month = z
  .string({ required_error: 'Please choose the month.' })
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Please choose a valid month.');

const settlementSchema = z.object({
  courier_id: uuid('Please choose the courier.'),
  month,
  shipment_ids: z
    .array(uuid('Please choose the parcels to pay for.'), { required_error: 'Please choose at least one parcel.' })
    .min(1, 'Please choose at least one parcel.')
    .max(500, 'Too many parcels in one payment.'),
  amount: moneyField('amount paid', { positive: true }),
  paid_on: dateField('payment date'),
  payment_method: z.string({ required_error: 'Please choose how it was paid.' }).trim().min(1, 'Please choose how it was paid.'),
  note: optionalText(300, 'note'),
});

// The orders and customers inside a parcel, for display.
const PARCEL_SELECT = `
  SELECT s.shipment_id AS id, s.shipment_code AS code, to_char(s.shipped_on, 'YYYY-MM-DD') AS shipped_on,
         s.shipment_status AS status, s.courier_cost, ord.units, ord.orders, ord.customers
    FROM shipment s
    LEFT JOIN LATERAL (
      SELECT SUM(si.quantity)::int AS units,
             jsonb_agg(DISTINCT jsonb_build_object('id', o.order_id, 'code', o.order_code)) AS orders,
             string_agg(DISTINCT COALESCE(c.name, 'Walk-in customer'), ', ') AS customers
        FROM shipment_item si
        JOIN order_item i ON i.order_item_id = si.order_item_id
        JOIN customer_order o ON o.order_id = i.order_id
        LEFT JOIN customer c ON c.customer_id = o.customer_id
       WHERE si.shipment_id = s.shipment_id) ord ON true`;

const presentParcel = (p) => ({ ...p, courier_cost: formatMoney(p.courier_cost) });

// ---------- what is waiting to be paid ----------
courierRouter.get('/payable', async (req, res, next) => {
  try {
    const db = getDb(req);
    // same grouping as the courier_payable view; months with nothing to pay (all parcels cost 0) are not listed
    const { rows } = await db.query(
      `SELECT cr.supplier_id AS courier_id, cr.name AS courier, to_char(date_trunc('month', s.shipped_on), 'YYYY-MM') AS month,
              COUNT(*)::int AS parcels, SUM(s.courier_cost) AS amount_due
         FROM shipment s JOIN supplier cr ON cr.supplier_id = s.courier_supplier_id
        WHERE s.courier_settlement_id IS NULL
        GROUP BY cr.supplier_id, cr.name, date_trunc('month', s.shipped_on)
       HAVING SUM(s.courier_cost) > 0
        ORDER BY 3, 2`,
    );
    const methods = await db.query('SELECT name FROM payment_method_ref ORDER BY name');
    const thisMonth = todayInIndia().slice(0, 7);
    res.json({
      groups: rows.map((r) => ({ ...r, amount_due: formatMoney(r.amount_due), month_over: r.month < thisMonth })),
      methods: methods.rows.map((m) => m.name),
      today: todayInIndia(),
    });
  } catch (err) {
    next(err);
  }
});

// The unpaid parcels of one courier in one month (the checklist in the pop-up).
courierRouter.get('/parcels', async (req, res, next) => {
  try {
    const q = z.object({ courier_id: uuid('Please choose the courier.'), month }).parse(req.query);
    const { rows } = await getDb(req).query(
      `${PARCEL_SELECT}
        WHERE s.courier_settlement_id IS NULL AND s.courier_supplier_id = $1
          AND date_trunc('month', s.shipped_on) = $2::date
        ORDER BY s.shipped_on, s.shipment_code`,
      [q.courier_id, `${q.month}-01`],
    );
    res.json({ parcels: rows.map(presentParcel) });
  } catch (err) {
    next(err);
  }
});

// ---------- settlements ----------
const SETTLEMENT_SELECT = `
  SELECT ss.settlement_id AS id, ss.settlement_code AS code, ss.courier, cs.courier_supplier_id AS courier_id,
         to_char(ss.period_month, 'YYYY-MM') AS month, to_char(ss.paid_on, 'YYYY-MM-DD') AS paid_on,
         ss.amount_paid, ss.shipments_total, ss.difference, ss.reconciliation, cs.payment_method, cs.note,
         (SELECT COUNT(*)::int FROM shipment s WHERE s.courier_settlement_id = ss.settlement_id) AS parcels
    FROM courier_settlement_summary ss
    JOIN courier_settlement cs ON cs.settlement_id = ss.settlement_id`;

const presentSettlement = (s) => ({
  ...s,
  amount_paid: formatMoney(s.amount_paid),
  shipments_total: formatMoney(s.shipments_total),
  difference: formatMoney(s.difference),
});

async function fetchSettlement(db, id) {
  const head = await db.query(`${SETTLEMENT_SELECT} WHERE ss.settlement_id = $1`, [id]);
  if (head.rowCount === 0) return null;
  const parcels = await db.query(`${PARCEL_SELECT} WHERE s.courier_settlement_id = $1 ORDER BY s.shipped_on, s.shipment_code`, [id]);
  return { ...presentSettlement(head.rows[0]), parcel_list: parcels.rows.map(presentParcel) };
}

courierRouter.get('/settlements', async (req, res, next) => {
  try {
    const { rows } = await getDb(req).query(`${SETTLEMENT_SELECT} ORDER BY cs.paid_on DESC, ss.settlement_code DESC`);
    res.json({ settlements: rows.map(presentSettlement) });
  } catch (err) {
    next(err);
  }
});

courierRouter.get('/settlements/:id', async (req, res, next) => {
  try {
    const settlement = await fetchSettlement(getDb(req), uuid('That payment was not found.').parse(req.params.id));
    if (!settlement) throw new UserError('That payment was not found.', 404);
    res.json({ settlement });
  } catch (err) {
    next(err);
  }
});

courierRouter.post('/settlements', async (req, res, next) => {
  try {
    const v = settlementSchema.parse(req.body);
    const id = await inTransaction(req, async (db) => {
      const courier = await db.query('SELECT name FROM supplier WHERE supplier_id = $1', [v.courier_id]);
      if (courier.rowCount === 0) throw new UserError('That courier was not found.', 400);

      const ids = [...new Set(v.shipment_ids)];
      const parcels = (await db.query(
        `SELECT shipment_id AS id, shipment_code AS code, courier_supplier_id, courier_settlement_id,
                to_char(shipped_on, 'YYYY-MM') AS month, courier_cost
           FROM shipment WHERE shipment_id = ANY($1::uuid[]) ORDER BY shipment_code FOR UPDATE`,
        [ids],
      )).rows;
      if (parcels.length !== ids.length) throw new UserError('One of the parcels was not found. Please refresh and try again.', 400);
      for (const p of parcels) {
        if (p.courier_settlement_id) throw new UserError(`${p.code} has already been paid to the courier.`, 400);
        if (p.courier_supplier_id !== v.courier_id) throw new UserError(`${p.code} was sent with a different courier.`, 400);
        if (p.month !== v.month) throw new UserError(`${p.code} was shipped in a different month than the one you chose.`, 400);
      }

      const due = parcels.reduce((sum, p) => sum.plus(p.courier_cost), new Decimal(0));
      if (due.lte(0)) throw new UserError('These parcels have no courier cost, so there is nothing to pay.', 400);

      const method = await db.query('SELECT 1 FROM payment_method_ref WHERE name = $1', [v.payment_method]);
      if (method.rowCount === 0) throw new UserError('Please choose a valid payment method.', 400);

      if (!v.amount.equals(due) && !v.note) {
        throw new UserError(
          `The amount paid (₹${v.amount.toFixed(2)}) is different from the parcels' total (₹${due.toFixed(2)}). Please explain the difference in the note.`,
          400,
        );
      }

      const code = await nextCode(db, { table: 'courier_settlement', column: 'settlement_code', prefix: 'CS_', width: 7 });
      const settlement = await db.query(
        `INSERT INTO courier_settlement (settlement_code, courier_supplier_id, period_month, paid_on, amount, payment_method, note)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7) RETURNING settlement_id`,
        [code, v.courier_id, `${v.month}-01`, v.paid_on, v.amount.toFixed(2), v.payment_method, v.note],
      );
      const settlementId = settlement.rows[0].settlement_id;
      const linked = await db.query(
        'UPDATE shipment SET courier_settlement_id = $1 WHERE shipment_id = ANY($2::uuid[]) AND courier_settlement_id IS NULL',
        [settlementId, ids],
      );
      if (linked.rowCount !== ids.length) throw new UserError('One of the parcels changed while you were saving. Please refresh and try again.', 409);
      return settlementId;
    });
    res.status(201).json({ settlement: await fetchSettlement(getDb(req), id) });
  } catch (err) {
    next(err);
  }
});
