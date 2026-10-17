// Reports: READ-ONLY. Nothing here writes to the database. Every figure is computed in SQL as exact numeric and returned
// as a "123.45" string. Definitions (also written in docs/README):
//   Sales  = items value after discounts of orders PLACED in the period (order date). Shipping is not sales.
//   Cost   = the cost snapshot on each order line. Profit = sales - cost.
//   Money in  = completed customer payments. Money out = completed supplier payments + customer refunds + courier month-end
//               payments + general expenses. (By the date of the payment.)
//   Stock, amounts owed and amounts to collect are "as of now", not by period.
import { Router } from 'express';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { getDb } from '../db.js';
import { UserError } from '../errors.js';
import { formatMoney } from '../money.js';
import { todayInIndia } from '../validation.js';

export const reportsRouter = Router();

const MAX_MONTHS = 60;
const monthText = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Please choose a valid month.');
const periodQuery = z.object({ from: monthText.optional(), to: monthText.optional() });

const nextMonthStart = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
  return d.toISOString().slice(0, 10);
};

// from/to as month text (or null = open ended) plus the dates SQL uses: lo inclusive, hi exclusive.
function readPeriod(req) {
  const clean = Object.fromEntries(Object.entries(req.query).filter(([, value]) => value !== ''));
  const q = periodQuery.parse(clean);
  if (q.from && q.to && q.from > q.to) throw new UserError("The 'from' month can't be after the 'to' month.", 400);
  return { from: q.from ?? null, to: q.to ?? null, lo: q.from ? `${q.from}-01` : null, hi: q.to ? nextMonthStart(q.to) : null };
}

// The list of months a chart or table needs (open ends are filled from the data, up to this month).
async function monthsOf(db, p) {
  const current = todayInIndia().slice(0, 7);
  let first = p.from;
  if (!first) {
    const { rows } = await db.query(
      `SELECT to_char(LEAST((SELECT MIN(order_date) FROM customer_order), (SELECT MIN(txn_date) FROM payment_transaction),
                            (SELECT MIN(shipped_on) FROM shipment), (SELECT MIN(paid_on) FROM courier_settlement),
                            (SELECT MIN(expense_date) FROM expense)), 'YYYY-MM') AS m`,
    );
    first = rows[0].m ?? current;
  }
  const last = p.to ?? (current > first ? current : first);
  const months = [];
  for (let [y, m] = first.split('-').map(Number); `${y}-${String(m).padStart(2, '0')}` <= last; m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  if (months.length <= MAX_MONTHS) return { months, truncated: false };
  // A start month the person chose is respected or refused. "All time" (no start) just shows the most recent months.
  if (p.from) throw new UserError(`Please choose a shorter period (${MAX_MONTHS} months at most).`, 400);
  return { months: months.slice(-MAX_MONTHS), truncated: true };
}

const dec = (value) => new Decimal(value ?? 0);
const money = (value) => formatMoney(dec(value));
const percent = (part, whole) => (dec(whole).isZero() ? null : dec(part).div(whole).times(100).toDecimalPlaces(1).toString());

// ---------- overview: the tiles ----------
reportsRouter.get('/overview', async (req, res, next) => {
  try {
    const p = readPeriod(req);
    const db = getDb(req);
    const range = [p.lo, p.hi];

    const sales = (await db.query(
      `SELECT COUNT(*)::int AS orders, COALESCE(SUM(ordered_qty), 0)::int AS pieces, COALESCE(SUM(items_total), 0) AS sales,
              COALESCE(SUM(product_cost), 0) AS cost, COALESCE(SUM(items_total - product_cost), 0) AS profit,
              COALESCE(SUM(items_total) FILTER (WHERE status IN ('Pending', 'Partially Shipped')), 0) AS in_orders_to_ship
         FROM order_summary
        WHERE ($1::date IS NULL OR order_date >= $1) AND ($2::date IS NULL OR order_date < $2)`,
      range,
    )).rows[0];

    const pay = (await db.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'In'), 0) AS money_in,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'Out' AND purchase_order_id IS NOT NULL), 0) AS to_suppliers,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'Out' AND order_id IS NOT NULL), 0) AS refunds
         FROM payment_transaction
        WHERE payment_status = 'Completed' AND ($1::date IS NULL OR txn_date >= $1) AND ($2::date IS NULL OR txn_date < $2)`,
      range,
    )).rows[0];
    const couriers = (await db.query(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM courier_settlement WHERE ($1::date IS NULL OR paid_on >= $1) AND ($2::date IS NULL OR paid_on < $2)',
      range,
    )).rows[0];
    const expenses = (await db.query(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM expense WHERE ($1::date IS NULL OR expense_date >= $1) AND ($2::date IS NULL OR expense_date < $2)',
      range,
    )).rows[0];
    const shipping = (await db.query(
      `SELECT COUNT(*)::int AS parcels, COALESCE(SUM(shipping_charged), 0) AS charged, COALESCE(SUM(courier_cost), 0) AS courier_cost
         FROM shipment WHERE ($1::date IS NULL OR shipped_on >= $1) AND ($2::date IS NULL OR shipped_on < $2)`,
      range,
    )).rows[0];

    // as of now
    const stock = (await db.query(
      `SELECT COALESCE(SUM(on_hand), 0)::int AS pieces, COALESCE(SUM(on_hand * unit_cost), 0) AS value,
              COUNT(*) FILTER (WHERE on_hand > 0)::int AS variants_in_stock, COUNT(*) FILTER (WHERE on_hand <= 0)::int AS variants_out_of_stock
         FROM inventory_balance`,
    )).rows[0];
    const suppliersOwed = (await db.query('SELECT COALESCE(SUM(balance) FILTER (WHERE balance > 0), 0) AS total, COUNT(*) FILTER (WHERE balance > 0)::int AS purchases FROM purchase_order_summary')).rows[0];
    const couriersOwed = (await db.query('SELECT COALESCE(SUM(amount_due), 0) AS total FROM courier_payable')).rows[0];
    const customers = (await db.query(
      `SELECT COALESCE(SUM(balance) FILTER (WHERE balance > 0), 0) AS to_collect, COUNT(*) FILTER (WHERE balance > 0)::int AS orders,
              COALESCE(SUM(-balance) FILTER (WHERE balance < 0), 0) AS credit_held
         FROM order_summary`,
    )).rows[0];

    const out = dec(pay.to_suppliers).plus(pay.refunds).plus(couriers.total).plus(expenses.total);
    res.json({
      period: { from: p.from, to: p.to },
      sales: {
        orders: sales.orders, pieces: sales.pieces, sales: money(sales.sales), cost: money(sales.cost), profit: money(sales.profit),
        margin_percent: percent(sales.profit, sales.sales), in_orders_to_ship: money(sales.in_orders_to_ship),
      },
      money: {
        in: money(pay.money_in), out: money(out), net: money(dec(pay.money_in).minus(out)),
        to_suppliers: money(pay.to_suppliers), to_couriers: money(couriers.total), refunds: money(pay.refunds), expenses: money(expenses.total),
      },
      shipping: {
        parcels: shipping.parcels, charged: money(shipping.charged), courier_cost: money(shipping.courier_cost),
        difference: money(dec(shipping.charged).minus(shipping.courier_cost)),
      },
      stock: { pieces: stock.pieces, value: money(stock.value), variants_in_stock: stock.variants_in_stock, variants_out_of_stock: stock.variants_out_of_stock },
      owed: {
        to_suppliers: money(suppliersOwed.total), supplier_purchases: suppliersOwed.purchases, to_couriers: money(couriersOwed.total),
        to_collect: money(customers.to_collect), orders_to_collect: customers.orders, credit_held: money(customers.credit_held),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------- month by month ----------
reportsRouter.get('/monthly', async (req, res, next) => {
  try {
    const p = readPeriod(req);
    const db = getDb(req);
    const { months, truncated } = await monthsOf(db, p);
    const { rows } = await db.query(
      `WITH sales AS (
         SELECT to_char(order_date, 'YYYY-MM') AS m, COUNT(*) AS orders, SUM(ordered_qty) AS pieces, SUM(items_total) AS sales, SUM(product_cost) AS cost
           FROM order_summary GROUP BY 1),
       pay AS (
         SELECT to_char(txn_date, 'YYYY-MM') AS m,
                SUM(amount) FILTER (WHERE direction = 'In') AS money_in,
                SUM(amount) FILTER (WHERE direction = 'Out' AND purchase_order_id IS NOT NULL) AS to_suppliers,
                SUM(amount) FILTER (WHERE direction = 'Out' AND order_id IS NOT NULL) AS refunds
           FROM payment_transaction WHERE payment_status = 'Completed' GROUP BY 1),
       cour AS (SELECT to_char(paid_on, 'YYYY-MM') AS m, SUM(amount) AS total FROM courier_settlement GROUP BY 1),
       exp AS (SELECT to_char(expense_date, 'YYYY-MM') AS m, SUM(amount) AS total FROM expense GROUP BY 1),
       ship AS (SELECT to_char(shipped_on, 'YYYY-MM') AS m, SUM(shipping_charged) AS charged, SUM(courier_cost) AS cost FROM shipment GROUP BY 1)
       SELECT mo.m AS month,
              COALESCE(s.orders, 0)::int AS orders, COALESCE(s.pieces, 0)::int AS pieces, COALESCE(s.sales, 0) AS sales, COALESCE(s.cost, 0) AS cost,
              COALESCE(pay.money_in, 0) AS money_in, COALESCE(pay.to_suppliers, 0) AS to_suppliers, COALESCE(pay.refunds, 0) AS refunds,
              COALESCE(cour.total, 0) AS to_couriers, COALESCE(exp.total, 0) AS expenses,
              COALESCE(ship.charged, 0) AS ship_charged, COALESCE(ship.cost, 0) AS ship_cost
         FROM unnest($1::text[]) AS mo(m)
         LEFT JOIN sales s ON s.m = mo.m
         LEFT JOIN pay ON pay.m = mo.m
         LEFT JOIN cour ON cour.m = mo.m
         LEFT JOIN exp ON exp.m = mo.m
         LEFT JOIN ship ON ship.m = mo.m
        ORDER BY mo.m`,
      [months],
    );
    res.json({
      truncated, // true when "all time" was longer than 60 months and only the latest 60 are shown
      months: rows.map((r) => {
        const out = dec(r.to_suppliers).plus(r.refunds).plus(r.to_couriers).plus(r.expenses);
        return {
          month: r.month, orders: r.orders, pieces: r.pieces,
          sales: money(r.sales), cost: money(r.cost), profit: money(dec(r.sales).minus(r.cost)), margin_percent: percent(dec(r.sales).minus(r.cost), r.sales),
          money_in: money(r.money_in), money_out: money(out), net: money(dec(r.money_in).minus(out)),
          to_suppliers: money(r.to_suppliers), to_couriers: money(r.to_couriers), refunds: money(r.refunds), expenses: money(r.expenses),
          ship_charged: money(r.ship_charged), ship_cost: money(r.ship_cost), ship_difference: money(dec(r.ship_charged).minus(r.ship_cost)),
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- by product ----------
reportsRouter.get('/products', async (req, res, next) => {
  try {
    const p = readPeriod(req);
    const group = z.enum(['product', 'variant']).default('product').parse(req.query.group || undefined);
    const keyColumns = group === 'product' ? 'p.product_id AS id, p.name AS name' : "v.variant_id AS id, v.sku || ' - ' || p.name AS name";
    const groupBy = group === 'product' ? 'p.product_id, p.name' : 'v.variant_id, v.sku, p.name';
    const { rows } = await getDb(req).query(
      `SELECT ${keyColumns}, SUM(i.quantity)::int AS pieces, SUM(i.quantity * i.unit_price - i.discount) AS sales,
              SUM(i.quantity * i.unit_cost_snapshot) AS cost
         FROM order_item i
         JOIN customer_order o ON o.order_id = i.order_id
         JOIN product_variant v ON v.variant_id = i.variant_id
         JOIN product p ON p.product_id = v.product_id
        WHERE ($1::date IS NULL OR o.order_date >= $1) AND ($2::date IS NULL OR o.order_date < $2)
        GROUP BY ${groupBy}
        ORDER BY SUM(i.quantity * i.unit_price - i.discount) DESC, 2`,
      [p.lo, p.hi],
    );
    const total = rows.reduce((sum, r) => sum.plus(r.sales), new Decimal(0));
    res.json({
      group,
      items: rows.map((r) => ({
        id: r.id, name: r.name, pieces: r.pieces, sales: money(r.sales), cost: money(r.cost), profit: money(dec(r.sales).minus(r.cost)),
        margin_percent: percent(dec(r.sales).minus(r.cost), r.sales), share_percent: percent(r.sales, total),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// product x month: sales and profit (the brief's "by month and product")
reportsRouter.get('/product-months', async (req, res, next) => {
  try {
    const p = readPeriod(req);
    const db = getDb(req);
    const { months, truncated } = await monthsOf(db, p);
    const { rows } = await db.query(
      `SELECT p.product_id AS id, p.name, to_char(o.order_date, 'YYYY-MM') AS month,
              SUM(i.quantity * i.unit_price - i.discount) AS sales, SUM(i.quantity * i.unit_cost_snapshot) AS cost
         FROM order_item i
         JOIN customer_order o ON o.order_id = i.order_id
         JOIN product_variant v ON v.variant_id = i.variant_id
         JOIN product p ON p.product_id = v.product_id
        WHERE to_char(o.order_date, 'YYYY-MM') = ANY($1::text[])
        GROUP BY p.product_id, p.name, to_char(o.order_date, 'YYYY-MM')`,
      [months],
    );
    const byProduct = new Map();
    for (const r of rows) {
      const entry = byProduct.get(r.id) ?? { id: r.id, name: r.name, cells: {}, sales: new Decimal(0), cost: new Decimal(0) };
      entry.cells[r.month] = { sales: dec(r.sales), cost: dec(r.cost) };
      entry.sales = entry.sales.plus(r.sales);
      entry.cost = entry.cost.plus(r.cost);
      byProduct.set(r.id, entry);
    }
    const products = [...byProduct.values()].sort((a, b) => b.sales.comparedTo(a.sales) || a.name.localeCompare(b.name));
    const columnTotals = months.map((m) => {
      const sales = products.reduce((sum, pr) => sum.plus(pr.cells[m]?.sales ?? 0), new Decimal(0));
      const cost = products.reduce((sum, pr) => sum.plus(pr.cells[m]?.cost ?? 0), new Decimal(0));
      return { sales: money(sales), profit: money(sales.minus(cost)) };
    });
    res.json({
      months,
      truncated,
      products: products.map((pr) => ({
        id: pr.id, name: pr.name, total_sales: money(pr.sales), total_profit: money(pr.sales.minus(pr.cost)),
        cells: months.map((m) => ({ sales: money(pr.cells[m]?.sales), profit: money(dec(pr.cells[m]?.sales).minus(pr.cells[m]?.cost ?? 0)) })),
      })),
      column_totals: columnTotals,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- stock now ----------
reportsRouter.get('/stock', async (req, res, next) => {
  try {
    const group = z.enum(['product', 'variant']).default('product').parse(req.query.group || undefined);
    const { rows } =
      group === 'product'
        ? await getDb(req).query(
            `SELECT product_name AS name, COUNT(*)::int AS variants, SUM(on_hand)::int AS on_hand, SUM(on_hand * unit_cost) AS value
               FROM inventory_balance GROUP BY product_name ORDER BY SUM(on_hand * unit_cost) DESC, product_name`,
          )
        : await getDb(req).query(
            `SELECT sku || ' - ' || product_name AS name, 1 AS variants, on_hand, on_hand * unit_cost AS value
               FROM inventory_balance ORDER BY on_hand * unit_cost DESC, sku`,
          );
    res.json({
      group,
      items: rows.map((r) => ({ name: r.name, variants: Number(r.variants), on_hand: r.on_hand, value: money(r.value) })),
      totals: { on_hand: rows.reduce((sum, r) => sum + r.on_hand, 0), value: money(rows.reduce((sum, r) => sum.plus(r.value), new Decimal(0))) },
    });
  } catch (err) {
    next(err);
  }
});

// ---------- who owes what ----------
reportsRouter.get('/payables', async (req, res, next) => {
  try {
    const db = getDb(req);
    const suppliers = await db.query(
      `SELECT po.supplier_id AS id, s.supplier AS name, COUNT(*)::int AS purchases, SUM(s.total_amount) AS total, SUM(s.paid) AS paid, SUM(s.balance) AS balance
         FROM purchase_order_summary s JOIN purchase_order po ON po.purchase_order_id = s.purchase_order_id
        WHERE s.balance > 0 GROUP BY po.supplier_id, s.supplier ORDER BY SUM(s.balance) DESC, s.supplier`,
    );
    const purchases = await db.query(
      `SELECT purchase_order_id AS id, po_code AS code, supplier, to_char(order_date, 'YYYY-MM-DD') AS order_date, total_amount AS total, paid, balance
         FROM purchase_order_summary WHERE balance > 0 ORDER BY order_date, po_code`,
    );
    const couriers = await db.query(
      `SELECT cr.supplier_id AS courier_id, cr.name AS courier, to_char(date_trunc('month', s.shipped_on), 'YYYY-MM') AS month,
              COUNT(*)::int AS parcels, SUM(s.courier_cost) AS amount_due
         FROM shipment s JOIN supplier cr ON cr.supplier_id = s.courier_supplier_id
        WHERE s.courier_settlement_id IS NULL
        GROUP BY cr.supplier_id, cr.name, date_trunc('month', s.shipped_on) HAVING SUM(s.courier_cost) > 0 ORDER BY 3, 2`,
    );
    const orders = await db.query(
      `SELECT order_id AS id, order_code AS code, customer, to_char(order_date, 'YYYY-MM-DD') AS order_date, status, order_total, received, balance
         FROM order_summary WHERE balance > 0 ORDER BY order_date, order_code`,
    );
    res.json({
      suppliers: suppliers.rows.map((r) => ({ ...r, total: money(r.total), paid: money(r.paid), balance: money(r.balance) })),
      purchases: purchases.rows.map((r) => ({ ...r, total: money(r.total), paid: money(r.paid), balance: money(r.balance) })),
      couriers: couriers.rows.map((r) => ({ ...r, amount_due: money(r.amount_due) })),
      orders: orders.rows.map((r) => ({ ...r, customer: r.customer ?? 'Walk-in customer', order_total: money(r.order_total), received: money(r.received), balance: money(r.balance) })),
    });
  } catch (err) {
    next(err);
  }
});
