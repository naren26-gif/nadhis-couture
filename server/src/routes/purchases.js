// Purchases: PO header + lines, receiving stock, and payments to the supplier.
// Money is Decimal / "450.00" strings. Totals are always computed here from the lines, never taken from the browser.
// Stock only enters when goods are RECEIVED, and every multi-table action runs in ONE transaction.
import { Router } from 'express';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { getDb, inTransaction } from '../db.js';
import { nextCode } from '../codes.js';
import { UserError } from '../errors.js';
import { formatMoney } from '../money.js';
import { dateField, moneyField, optionalText, quantity, uuid } from '../validation.js';

export const purchasesRouter = Router();

// ---------- input checks (plain-English messages; shared helpers live in ../validation.js) ----------
const lineSchema = z.object({
  item_id: z.string().uuid().optional(), // present when editing an existing line
  variant_id: uuid('Please choose the product for every line.'),
  quantity,
  unit_cost: moneyField('unit cost', { positive: false }).optional(),
});

const headerShape = {
  supplier_id: uuid('Please choose the supplier.'),
  order_date: dateField('purchase date'),
  notes: optionalText(500, 'notes'),
  lines: z.array(lineSchema).max(200, 'Too many lines in one purchase.').optional(),
  total: moneyField('total amount', { positive: true }).optional(),
};
const createSchema = z.object({
  ...headerShape,
  purchase_type: z.string({ required_error: 'Please choose the type of purchase.' }).trim().min(1, 'Please choose the type of purchase.'),
});
const updateSchema = z.object(headerShape);

const receiveSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({
    lines: z
      .array(z.object({ item_id: uuid('Please choose the line to receive.'), quantity }))
      .min(1, 'Please enter how many pieces you received.'),
  }),
]);

const paymentSchema = z.object({
  amount: moneyField('payment amount', { positive: true }),
  txn_date: dateField('payment date'),
  payment_method: z.string({ required_error: 'Please choose how it was paid.' }).trim().min(1, 'Please choose how it was paid.'),
  note: optionalText(300, 'note'),
});

const idParam = (req) => uuid('That purchase was not found.').parse(req.params.id);

// ---------- reading ----------
const BASE_SELECT = `
  SELECT s.purchase_order_id AS id, s.po_code AS code, po.supplier_id, s.supplier AS supplier_name,
         to_char(s.order_date, 'YYYY-MM-DD') AS order_date, s.purchase_type, t.affects_stock, po.notes,
         s.total_amount, s.paid, s.balance, s.payment_state,
         COALESCE(li.ordered, 0)::int AS ordered_qty, COALESCE(li.received, 0)::int AS received_qty,
         CASE WHEN NOT t.affects_stock THEN 'No stock'
              WHEN COALESCE(li.received, 0) = 0 THEN 'Not received'
              WHEN COALESCE(li.received, 0) < li.ordered THEN 'Partly received'
              ELSE 'Received' END AS receipt_status
    FROM purchase_order_summary s
    JOIN purchase_order po ON po.purchase_order_id = s.purchase_order_id
    JOIN purchase_type_ref t ON t.name = s.purchase_type
    LEFT JOIN LATERAL (
      SELECT SUM(qty_ordered) AS ordered, SUM(qty_received) AS received
        FROM purchase_order_item i WHERE i.purchase_order_id = s.purchase_order_id
    ) li ON true`;

function present(row) {
  return { ...row, total_amount: formatMoney(row.total_amount), paid: formatMoney(row.paid), balance: formatMoney(row.balance) };
}

async function fetchPurchase(db, id) {
  const head = await db.query(`${BASE_SELECT} WHERE s.purchase_order_id = $1`, [id]);
  if (head.rowCount === 0) return null;
  const lines = await db.query(
    `SELECT i.purchase_order_item_id AS item_id, i.line_no, i.variant_id, v.sku, p.name AS product_name,
            v.fabric, v.size, v.colour, v.is_active, i.qty_ordered, i.qty_received,
            (i.qty_ordered - i.qty_received) AS remaining, i.unit_cost, (i.qty_ordered * i.unit_cost) AS line_total
       FROM purchase_order_item i
       JOIN product_variant v ON v.variant_id = i.variant_id
       JOIN product p ON p.product_id = v.product_id
      WHERE i.purchase_order_id = $1 ORDER BY i.line_no`,
    [id],
  );
  const payments = await db.query(
    `SELECT transaction_id, transaction_code AS code, to_char(txn_date, 'YYYY-MM-DD') AS txn_date, amount,
            payment_method, payment_status, note, is_migration_adjustment
       FROM payment_transaction WHERE purchase_order_id = $1 ORDER BY txn_date, created_at`,
    [id],
  );
  return {
    ...present(head.rows[0]),
    lines: lines.rows.map((l) => ({ ...l, unit_cost: formatMoney(l.unit_cost), line_total: formatMoney(l.line_total) })),
    payments: payments.rows.map((p) => ({ ...p, amount: formatMoney(p.amount) })),
  };
}

// Dropdown contents for the purchase screens, in one call. (Declared before '/:id'.)
purchasesRouter.get('/lookups', async (req, res, next) => {
  try {
    const db = getDb(req);
    const types = await db.query('SELECT name, affects_stock FROM purchase_type_ref ORDER BY affects_stock DESC, name');
    const methods = await db.query('SELECT name FROM payment_method_ref ORDER BY name');
    const suppliers = await db.query('SELECT supplier_id AS id, supplier_code AS code, name FROM supplier WHERE is_active ORDER BY lower(name)');
    res.json({ types: types.rows, methods: methods.rows.map((m) => m.name), suppliers: suppliers.rows });
  } catch (err) {
    next(err);
  }
});

const listQuery = z.object({
  search: z.string().trim().max(80).optional(),
  supplier: z.string().uuid().optional(),
  type: z.string().max(80).optional(),
  payment: z.enum(['Unpaid', 'Partial', 'Paid', 'Overpaid']).optional(),
  receipt: z.enum(['Not received', 'Partly received', 'Received', 'No stock']).optional(),
});

purchasesRouter.get('/', async (req, res, next) => {
  try {
    const q = listQuery.parse(Object.fromEntries(Object.entries(req.query).filter(([, value]) => value !== '')));
    const db = getDb(req);
    const { rows } = await db.query(
      `SELECT * FROM (${BASE_SELECT}) x
        WHERE ($1::text IS NULL OR strpos(lower(x.code), lower($1)) > 0 OR strpos(lower(x.supplier_name), lower($1)) > 0
               OR strpos(lower(COALESCE(x.notes, '')), lower($1)) > 0)
          AND ($2::uuid IS NULL OR x.supplier_id = $2)
          AND ($3::text IS NULL OR x.purchase_type = $3)
          AND ($4::text IS NULL OR x.payment_state = $4)
          AND ($5::text IS NULL OR x.receipt_status = $5)
        ORDER BY x.order_date DESC, x.code DESC`,
      [q.search ?? null, q.supplier ?? null, q.type ?? null, q.payment ?? null, q.receipt ?? null],
    );
    const totals = await db.query(
      `SELECT COALESCE(SUM(balance) FILTER (WHERE balance > 0), 0) AS owed,
              COUNT(*) FILTER (WHERE balance > 0)::int AS unpaid_count
         FROM purchase_order_summary`,
    );
    const waiting = await db.query(
      `SELECT COUNT(*)::int AS n FROM (${BASE_SELECT}) x WHERE x.receipt_status IN ('Not received', 'Partly received')`,
    );
    res.json({
      purchases: rows.map(present),
      totals: { owed: formatMoney(totals.rows[0].owed), unpaid_count: totals.rows[0].unpaid_count, awaiting_receipt: waiting.rows[0].n },
    });
  } catch (err) {
    next(err);
  }
});

purchasesRouter.get('/:id', async (req, res, next) => {
  try {
    const purchase = await fetchPurchase(getDb(req), idParam(req));
    if (!purchase) throw new UserError('That purchase was not found.', 404);
    res.json({ purchase });
  } catch (err) {
    next(err);
  }
});

// ---------- shared checks ----------
async function loadSupplier(db, supplierId, { mustBeActive }) {
  const { rows } = await db.query('SELECT is_active FROM supplier WHERE supplier_id = $1', [supplierId]);
  if (rows.length === 0) throw new UserError('That supplier was not found.', 400);
  if (mustBeActive && !rows[0].is_active) throw new UserError('That supplier is hidden. Please choose another supplier.', 400);
}

async function loadVariants(db, variantIds) {
  const { rows } = await db.query(
    'SELECT variant_id, sku, unit_cost, is_active FROM product_variant WHERE variant_id = ANY($1::uuid[])',
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

const lineTotal = (qty, cost) => new Decimal(cost).times(qty);

// ---------- create ----------
purchasesRouter.post('/', async (req, res, next) => {
  try {
    const v = createSchema.parse(req.body);
    const id = await inTransaction(req, async (db) => {
      const type = await db.query('SELECT affects_stock FROM purchase_type_ref WHERE name = $1', [v.purchase_type]);
      if (type.rowCount === 0) throw new UserError('Please choose a valid type of purchase.', 400);
      await loadSupplier(db, v.supplier_id, { mustBeActive: true });

      let total;
      let lines = [];
      if (type.rows[0].affects_stock) {
        lines = v.lines ?? [];
        if (lines.length === 0) throw new UserError('Please add at least one product line.', 400);
        checkNoDuplicateVariants(lines);
        const variants = await loadVariants(db, lines.map((l) => l.variant_id));
        lines = lines.map((l) => {
          const variant = variants.get(l.variant_id);
          if (!variant.is_active) throw new UserError(`${variant.sku} is hidden. Show it again on the Products screen first.`, 400);
          return { ...l, unit_cost: l.unit_cost ?? new Decimal(variant.unit_cost) };
        });
        total = lines.reduce((sum, l) => sum.plus(lineTotal(l.quantity, l.unit_cost)), new Decimal(0));
        if (total.gt(new Decimal('9999999.99'))) throw new UserError('That total is too large.', 400);
      } else {
        if ((v.lines ?? []).length > 0) throw new UserError('This type of purchase has no product lines.', 400);
        if (!v.total) throw new UserError('Please enter the total amount.', 400);
        total = v.total;
      }

      const poCode = await nextCode(db, { table: 'purchase_order', column: 'po_code', prefix: 'PO_', width: 7 });
      const po = await db.query(
        `INSERT INTO purchase_order (po_code, supplier_id, order_date, purchase_type, total_amount, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING purchase_order_id`,
        [poCode, v.supplier_id, v.order_date, v.purchase_type, total.toFixed(2), v.notes],
      );
      const poId = po.rows[0].purchase_order_id;
      let lineNo = 0;
      for (const l of lines) {
        lineNo += 1;
        await db.query(
          `INSERT INTO purchase_order_item (purchase_order_id, line_no, variant_id, qty_ordered, unit_cost)
           VALUES ($1, $2, $3, $4, $5)`,
          [poId, lineNo, l.variant_id, l.quantity, new Decimal(l.unit_cost).toFixed(2)],
        );
      }
      return poId;
    });
    res.status(201).json({ purchase: await fetchPurchase(getDb(req), id) });
  } catch (err) {
    next(err);
  }
});

// ---------- edit (no deleting: lines can be changed or added, never removed) ----------
purchasesRouter.patch('/:id', async (req, res, next) => {
  try {
    const poId = idParam(req);
    const v = updateSchema.parse(req.body);
    await inTransaction(req, async (db) => {
      const head = await db.query(
        `SELECT po.supplier_id, t.affects_stock FROM purchase_order po
           JOIN purchase_type_ref t ON t.name = po.purchase_type
          WHERE po.purchase_order_id = $1 FOR UPDATE OF po`,
        [poId],
      );
      if (head.rowCount === 0) throw new UserError('That purchase was not found.', 404);
      const { supplier_id: oldSupplier, affects_stock: affectsStock } = head.rows[0];
      if (v.supplier_id !== oldSupplier) await loadSupplier(db, v.supplier_id, { mustBeActive: true });

      let total;
      if (affectsStock) {
        const existing = (await db.query(
          `SELECT purchase_order_item_id AS id, variant_id, qty_received, unit_cost, line_no
             FROM purchase_order_item WHERE purchase_order_id = $1 ORDER BY line_no FOR UPDATE`,
          [poId],
        )).rows;
        const lines = v.lines ?? [];
        checkNoDuplicateVariants(lines);
        const sent = new Set(lines.filter((l) => l.item_id).map((l) => l.item_id));
        for (const e of existing) {
          if (!sent.has(e.id)) throw new UserError("A line can't be removed. Change it instead (for example to the right product).", 400);
        }
        const byId = new Map(existing.map((e) => [e.id, e]));
        const variants = await loadVariants(db, lines.map((l) => l.variant_id));

        let nextLine = existing.reduce((max, e) => Math.max(max, e.line_no), 0);
        total = new Decimal(0);
        for (const l of lines) {
          const variant = variants.get(l.variant_id);
          if (l.item_id) {
            const e = byId.get(l.item_id);
            if (!e) throw new UserError('One of the lines does not belong to this purchase. Please refresh and try again.', 400);
            const sameVariant = e.variant_id === l.variant_id;
            const cost = l.unit_cost ?? (sameVariant ? new Decimal(e.unit_cost) : new Decimal(variant.unit_cost));
            if (e.qty_received > 0) {
              if (!sameVariant || !cost.equals(e.unit_cost)) {
                throw new UserError(`${variant.sku} has already been received, so its product and cost can't change.`, 400);
              }
              if (l.quantity < e.qty_received) {
                throw new UserError(`${variant.sku}: ${e.qty_received} already received, so the quantity can't be lower than that.`, 400);
              }
            } else if (!sameVariant && !variant.is_active) {
              throw new UserError(`${variant.sku} is hidden. Show it again on the Products screen first.`, 400);
            }
            await db.query(
              'UPDATE purchase_order_item SET variant_id = $2, qty_ordered = $3, unit_cost = $4 WHERE purchase_order_item_id = $1',
              [e.id, l.variant_id, l.quantity, cost.toFixed(2)],
            );
            total = total.plus(lineTotal(l.quantity, cost));
          } else {
            if (!variant.is_active) throw new UserError(`${variant.sku} is hidden. Show it again on the Products screen first.`, 400);
            const cost = l.unit_cost ?? new Decimal(variant.unit_cost);
            nextLine += 1;
            await db.query(
              `INSERT INTO purchase_order_item (purchase_order_id, line_no, variant_id, qty_ordered, unit_cost)
               VALUES ($1, $2, $3, $4, $5)`,
              [poId, nextLine, l.variant_id, l.quantity, cost.toFixed(2)],
            );
            total = total.plus(lineTotal(l.quantity, cost));
          }
        }
      } else {
        if ((v.lines ?? []).length > 0) throw new UserError('This type of purchase has no product lines.', 400);
        if (!v.total) throw new UserError('Please enter the total amount.', 400);
        total = v.total;
      }
      if (total.gt(new Decimal('9999999.99'))) throw new UserError('That total is too large.', 400);

      const paid = await db.query('SELECT paid FROM purchase_order_summary WHERE purchase_order_id = $1', [poId]);
      if (total.lt(paid.rows[0].paid)) {
        throw new UserError(`The total can't be less than the ${formatMoney(paid.rows[0].paid)} already paid.`, 400);
      }
      await db.query(
        'UPDATE purchase_order SET supplier_id = $2, order_date = $3, notes = $4, total_amount = $5 WHERE purchase_order_id = $1',
        [poId, v.supplier_id, v.order_date, v.notes, total.toFixed(2)],
      );
    });
    res.json({ purchase: await fetchPurchase(getDb(req), poId) });
  } catch (err) {
    next(err);
  }
});

// ---------- receive stock ----------
purchasesRouter.post('/:id/receive', async (req, res, next) => {
  try {
    const poId = idParam(req);
    const body = receiveSchema.parse(req.body);
    const pieces = await inTransaction(req, async (db) => {
      const head = await db.query(
        `SELECT po.po_code, t.affects_stock FROM purchase_order po
           JOIN purchase_type_ref t ON t.name = po.purchase_type
          WHERE po.purchase_order_id = $1 FOR UPDATE OF po`,
        [poId],
      );
      if (head.rowCount === 0) throw new UserError('That purchase was not found.', 404);
      if (!head.rows[0].affects_stock) throw new UserError('This purchase has no stock to receive.', 400);

      const items = (await db.query(
        `SELECT i.purchase_order_item_id AS id, i.variant_id, i.qty_ordered, i.qty_received, v.sku
           FROM purchase_order_item i JOIN product_variant v ON v.variant_id = i.variant_id
          WHERE i.purchase_order_id = $1 ORDER BY i.line_no FOR UPDATE OF i`,
        [poId],
      )).rows;
      const byId = new Map(items.map((i) => [i.id, i]));

      let plan;
      if ('all' in body) {
        plan = items.filter((i) => i.qty_ordered > i.qty_received).map((i) => ({ item: i, qty: i.qty_ordered - i.qty_received }));
      } else {
        const seen = new Set();
        plan = body.lines.map((l) => {
          const item = byId.get(l.item_id);
          if (!item) throw new UserError('One of the lines does not belong to this purchase. Please refresh and try again.', 400);
          if (seen.has(l.item_id)) throw new UserError('The same line is listed twice.', 400);
          seen.add(l.item_id);
          const remaining = item.qty_ordered - item.qty_received;
          if (l.quantity > remaining) {
            throw new UserError(remaining === 0 ? `${item.sku} has already been fully received.` : `Only ${remaining} still to receive on ${item.sku}.`, 400);
          }
          return { item, qty: l.quantity };
        });
      }
      if (plan.length === 0) throw new UserError('Nothing is left to receive on this purchase.', 400);

      for (const { item, qty } of plan) {
        await db.query('UPDATE purchase_order_item SET qty_received = qty_received + $2 WHERE purchase_order_item_id = $1', [item.id, qty]);
        await db.query(
          `INSERT INTO inventory_movement (variant_id, movement_type, quantity, moved_at, purchase_order_item_id, reason, created_by)
           VALUES ($1, 'Purchase Receipt', $2, clock_timestamp(), $3, $4, $5)`,
          [item.variant_id, qty, item.id, `Received on ${head.rows[0].po_code}`, req.user.name],
        );
      }
      return plan.reduce((sum, p) => sum + p.qty, 0);
    });
    res.json({ received_pieces: pieces, purchase: await fetchPurchase(getDb(req), poId) });
  } catch (err) {
    next(err);
  }
});

// ---------- pay the supplier ----------
purchasesRouter.post('/:id/payments', async (req, res, next) => {
  try {
    const poId = idParam(req);
    const p = paymentSchema.parse(req.body);
    await inTransaction(req, async (db) => {
      // lock the purchase so two people paying at once cannot overpay it
      const locked = await db.query('SELECT 1 FROM purchase_order WHERE purchase_order_id = $1 FOR UPDATE', [poId]);
      if (locked.rowCount === 0) throw new UserError('That purchase was not found.', 404);

      const method = await db.query('SELECT 1 FROM payment_method_ref WHERE name = $1', [p.payment_method]);
      if (method.rowCount === 0) throw new UserError('Please choose a valid payment method.', 400);

      const { rows } = await db.query('SELECT balance FROM purchase_order_summary WHERE purchase_order_id = $1', [poId]);
      const balance = new Decimal(rows[0].balance);
      if (balance.lte(0)) throw new UserError('This purchase is already fully paid.', 400);
      if (p.amount.gt(balance)) throw new UserError(`The balance is only ₹${balance.toFixed(2)}. Please enter that or less.`, 400);

      const tranCode = await nextCode(db, { table: 'payment_transaction', column: 'transaction_code', prefix: 'TRAN_', width: 8 });
      await db.query(
        `INSERT INTO payment_transaction
           (transaction_code, txn_date, direction, amount, payment_method, payment_status, purchase_order_id, note)
         VALUES ($1, $2, 'Out', $3, $4, 'Completed', $5, $6)`,
        [tranCode, p.txn_date, p.amount.toFixed(2), p.payment_method, poId, p.note],
      );
    });
    res.status(201).json({ purchase: await fetchPurchase(getDb(req), poId) });
  } catch (err) {
    next(err);
  }
});
