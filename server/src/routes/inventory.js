import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db.js';
import { UserError } from '../errors.js';
import { formatMoney } from '../money.js';

export const inventoryRouter = Router();

const id = (label) => z.string({ required_error: `Please choose the ${label}.` }).uuid(`Please choose the ${label}.`);

const adjustmentSchema = z.object({
  variant_id: id('variant'),
  direction: z.enum(['add', 'remove'], { errorMap: () => ({ message: 'Please choose whether to add or remove stock.' }) }),
  quantity: z
    .number({ required_error: 'Please enter the quantity.', invalid_type_error: 'The quantity must be a whole number, 1 or more.' })
    .int('The quantity must be a whole number, 1 or more.')
    .min(1, 'The quantity must be a whole number, 1 or more.')
    .max(100000, 'That quantity is too large.'),
  reason: z
    .string({ required_error: 'Please give a reason for the adjustment.' })
    .trim()
    .min(3, 'Please give a reason for the adjustment (at least 3 letters).')
    .max(200, 'The reason is too long (200 characters at most).'),
});

const listQuery = z.object({
  search: z.string().trim().max(80).optional(),
  product: z.string().uuid().optional(),
  fabric: z.string().max(60).optional(),
  size: z.string().max(10).optional(),
  colour: z.string().max(60).optional(),
  stock: z.enum(['all', 'in', 'out']).default('all'),
  inactive: z.enum(['true', 'false']).default('false'),
});

// ---------- stock list ----------
inventoryRouter.get('/', async (req, res, next) => {
  try {
    const q = listQuery.parse(Object.fromEntries(Object.entries(req.query).filter(([, value]) => value !== '')));
    const { rows } = await getDb(req).query(
      `SELECT b.variant_id, b.sku, b.product_name, b.fabric, b.size, b.colour, b.unit_cost, b.on_hand,
              (b.on_hand * b.unit_cost) AS stock_value, v.is_active
         FROM inventory_balance b
         JOIN product_variant v ON v.variant_id = b.variant_id
         JOIN size_ref sr ON sr.code = b.size
        WHERE ($1::text IS NULL OR strpos(lower(b.sku), lower($1)) > 0 OR strpos(lower(b.product_name), lower($1)) > 0
               OR strpos(lower(b.fabric), lower($1)) > 0 OR strpos(lower(b.colour), lower($1)) > 0)
          AND ($2::uuid IS NULL OR v.product_id = $2)
          AND ($3::text IS NULL OR b.fabric = $3)
          AND ($4::text IS NULL OR b.size = $4)
          AND ($5::text IS NULL OR b.colour = $5)
          AND ($6 = 'all' OR ($6 = 'in' AND b.on_hand > 0) OR ($6 = 'out' AND b.on_hand <= 0))
          AND ($7::boolean OR v.is_active)
        ORDER BY b.product_name, b.fabric, sr.sort_order, b.colour`,
      [q.search ?? null, q.product ?? null, q.fabric ?? null, q.size ?? null, q.colour ?? null, q.stock, q.inactive === 'true'],
    );
    const totals = await getDb(req).query(
      `SELECT COALESCE(SUM(b.on_hand), 0)::int AS pieces, COALESCE(SUM(b.on_hand * b.unit_cost), 0) AS value
         FROM inventory_balance b`, // ALL variants: a hidden variant still holds stock (and the Reports screen counts it too)
    );
    res.json({
      variants: rows.map((row) => ({ ...row, unit_cost: formatMoney(row.unit_cost), stock_value: formatMoney(row.stock_value) })),
      totals: { pieces: totals.rows[0].pieces, value: formatMoney(totals.rows[0].value) },
    });
  } catch (err) {
    next(err);
  }
});

// ---------- history of one variant ----------
inventoryRouter.get('/:id/movements', async (req, res, next) => {
  try {
    const variantId = id('variant').parse(req.params.id);
    const db = getDb(req);
    const variant = await db.query('SELECT sku FROM product_variant WHERE variant_id = $1', [variantId]);
    if (variant.rowCount === 0) throw new UserError('That variant was not found.', 404);
    const { rows } = await db.query(
      `SELECT movement_id, movement_type, quantity, reason, created_by,
              to_char(moved_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, HH24:MI') AS moved_on
         FROM inventory_movement
        WHERE variant_id = $1
        ORDER BY moved_at DESC, created_at DESC
        LIMIT 100`,
      [variantId],
    );
    res.json({ sku: variant.rows[0].sku, movements: rows });
  } catch (err) {
    next(err);
  }
});

// ---------- adjust stock (history is never edited: this adds a new Adjustment row) ----------
inventoryRouter.post('/adjustments', async (req, res, next) => {
  try {
    const a = adjustmentSchema.parse(req.body);
    const db = getDb(req);
    const found = await db.query(
      `SELECT v.sku, v.is_active, COALESCE(b.on_hand, 0) AS on_hand
         FROM product_variant v LEFT JOIN inventory_balance b ON b.variant_id = v.variant_id
        WHERE v.variant_id = $1`,
      [a.variant_id],
    );
    if (found.rowCount === 0) throw new UserError('That variant was not found.', 404);
    const { sku, is_active: active, on_hand: onHand } = found.rows[0];
    if (!active) throw new UserError(`${sku} is hidden. Show it again on the Products screen before changing its stock.`, 400);
    if (a.direction === 'remove' && a.quantity > onHand) {
      throw new UserError(`Not enough stock: only ${onHand} left`, 400);
    }

    const signed = a.direction === 'add' ? a.quantity : -a.quantity;
    const { rows } = await db
      .query(
        `INSERT INTO inventory_movement (variant_id, movement_type, quantity, moved_at, reason, created_by)
         VALUES ($1, 'Adjustment', $2, clock_timestamp(), $3, $4) RETURNING movement_id`,
        [a.variant_id, signed, a.reason, req.user.name],
      )
      .catch((err) => {
        // someone else took the stock a moment ago: the database refused to go below zero
        if (err?.code === '23514' && /Insufficient stock/.test(err.message)) {
          throw new UserError('Not enough stock: it changed a moment ago. Please refresh and try again.', 409);
        }
        throw err;
      });
    const after = await db.query('SELECT on_hand FROM inventory_balance WHERE variant_id = $1', [a.variant_id]);
    res.status(201).json({ movement_id: rows[0].movement_id, sku, on_hand: after.rows[0].on_hand });
  } catch (err) {
    next(err);
  }
});
