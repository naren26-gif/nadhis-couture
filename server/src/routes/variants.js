import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db.js';
import { requireRole } from '../auth/index.js';
import { UserError } from '../errors.js';
import { formatMoney, margin, marginPercent, parseMoney } from '../money.js';
import { suggestSku } from '../skus.js';

export const variantsRouter = Router();

// ---------- input checks (plain-English messages) ----------
const money = (label) =>
  z
    .string({ required_error: `Please enter the ${label}.` })
    .transform((text, ctx) => {
      const value = parseMoney(text);
      if (!value) {
        ctx.addIssue({
          code: 'custom',
          message: `The ${label} must be a number, 0 or more, with at most 2 decimals (for example 450 or 450.50).`,
        });
        return z.NEVER;
      }
      return value.toFixed(2);
    });

const id = (label) => z.string({ required_error: `Please choose the ${label}.` }).uuid(`Please choose the ${label}.`);
const pick = (label) => z.string({ required_error: `Please choose the ${label}.` }).trim().min(1, `Please choose the ${label}.`);

const supplierField = z
  .union([z.string().uuid('Please choose a valid supplier.'), z.literal(''), z.null()])
  .optional()
  .transform((value) => value || null);

const sku = z
  .string({ required_error: 'Please enter a SKU.' })
  .trim()
  .min(1, 'Please enter a SKU.')
  .max(40, 'The SKU is too long (40 characters at most).')
  .transform((text) => text.toUpperCase())
  .refine((text) => /^[A-Z0-9][A-Z0-9_-]*$/.test(text), 'The SKU can only use letters, numbers, dashes and underscores.');

const createSchema = z.object({
  product_id: id('product'),
  fabric: pick('fabric'),
  size: pick('size'),
  colour: pick('colour'),
  unit_cost: money('unit cost'),
  list_price: money('list price'),
  default_supplier_id: supplierField,
  sku,
});

const updateSchema = z.object({
  unit_cost: money('unit cost'),
  list_price: money('list price'),
  default_supplier_id: supplierField,
});

// ---------- reading ----------
const VARIANT_COLUMNS = `
  v.variant_id, v.sku, v.product_id, p.name AS product_name, v.fabric, v.size, v.colour,
  v.unit_cost, v.list_price, v.default_supplier_id, s.name AS supplier_name, v.is_active,
  COALESCE(b.on_hand, 0) AS on_hand`;

const VARIANT_JOINS = `
  FROM product_variant v
  JOIN product p        ON p.product_id = v.product_id
  JOIN size_ref sr      ON sr.code = v.size
  LEFT JOIN supplier s  ON s.supplier_id = v.default_supplier_id
  LEFT JOIN inventory_balance b ON b.variant_id = v.variant_id`;

function present(row) {
  return {
    ...row,
    unit_cost: formatMoney(row.unit_cost),
    list_price: formatMoney(row.list_price),
    margin: formatMoney(margin(row.list_price, row.unit_cost)),
    margin_percent: marginPercent(row.list_price, row.unit_cost),
  };
}

async function fetchVariant(db, variantId) {
  const { rows } = await db.query(`SELECT ${VARIANT_COLUMNS} ${VARIANT_JOINS} WHERE v.variant_id = $1`, [variantId]);
  return rows[0] ? present(rows[0]) : null;
}

const listQuery = z.object({
  search: z.string().trim().max(80).optional(),
  product: z.string().uuid().optional(),
  fabric: z.string().max(60).optional(),
  size: z.string().max(10).optional(),
  colour: z.string().max(60).optional(),
  stock: z.enum(['all', 'in', 'out']).default('all'),
  inactive: z.enum(['true', 'false']).default('false'),
});

variantsRouter.get('/', async (req, res, next) => {
  try {
    // an empty filter box means "no filter"
    const q = listQuery.parse(Object.fromEntries(Object.entries(req.query).filter(([, value]) => value !== '')));
    const { rows } = await getDb(req).query(
      `SELECT ${VARIANT_COLUMNS} ${VARIANT_JOINS}
        WHERE ($1::text IS NULL OR $1 = ''
               OR strpos(lower(v.sku), lower($1)) > 0 OR strpos(lower(p.name), lower($1)) > 0
               OR strpos(lower(v.fabric), lower($1)) > 0 OR strpos(lower(v.colour), lower($1)) > 0)
          AND ($2::uuid IS NULL OR v.product_id = $2)
          AND ($3::text IS NULL OR v.fabric = $3)
          AND ($4::text IS NULL OR v.size = $4)
          AND ($5::text IS NULL OR v.colour = $5)
          AND ($6 = 'all' OR ($6 = 'in' AND COALESCE(b.on_hand, 0) > 0) OR ($6 = 'out' AND COALESCE(b.on_hand, 0) <= 0))
          AND ($7::boolean OR v.is_active)
        ORDER BY p.name, v.fabric, sr.sort_order, v.colour`,
      [q.search ?? null, q.product ?? null, q.fabric ?? null, q.size ?? null, q.colour ?? null, q.stock, q.inactive === 'true'],
    );
    res.json({ variants: rows.map(present) });
  } catch (err) {
    next(err);
  }
});

// Must come before '/:id' so "suggest-sku" is not mistaken for an id.
variantsRouter.get('/suggest-sku', async (req, res, next) => {
  try {
    const q = z
      .object({ product_id: id('product'), fabric: pick('fabric'), size: pick('size'), colour: pick('colour') })
      .parse(req.query);
    const db = getDb(req);
    const product = await db.query('SELECT name FROM product WHERE product_id = $1', [q.product_id]);
    if (product.rowCount === 0) throw new UserError('That product was not found.', 404);
    const existing = await db.query('SELECT sku, product_id, fabric, size, colour FROM product_variant');
    res.json({
      sku: suggestSku(
        { productId: q.product_id, productName: product.rows[0].name, fabric: q.fabric, size: q.size, colour: q.colour },
        existing.rows,
      ),
    });
  } catch (err) {
    next(err);
  }
});

variantsRouter.get('/:id', async (req, res, next) => {
  try {
    const variantId = id('variant').parse(req.params.id);
    const variant = await fetchVariant(getDb(req), variantId);
    if (!variant) throw new UserError('That variant was not found.', 404);
    res.json({ variant });
  } catch (err) {
    next(err);
  }
});

// ---------- writing ----------
function friendlyInsertError(err) {
  if (err?.code === '23505') {
    if (err.constraint === 'product_variant_sku_key') {
      return new UserError('That SKU is already used by another variant. Please change it.', 409);
    }
    return new UserError('This product already has a variant with that fabric, size and colour.', 409);
  }
  if (err?.code === '23503') {
    return new UserError('One of the chosen values (product, fabric, size, colour or supplier) no longer exists. Please refresh and try again.', 400);
  }
  return err;
}

variantsRouter.post('/', async (req, res, next) => {
  try {
    const v = createSchema.parse(req.body);
    const db = getDb(req);
    const { rows } = await db
      .query(
        `INSERT INTO product_variant (product_id, sku, fabric, size, colour, unit_cost, list_price, default_supplier_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING variant_id`,
        [v.product_id, v.sku, v.fabric, v.size, v.colour, v.unit_cost, v.list_price, v.default_supplier_id],
      )
      .catch((err) => {
        throw friendlyInsertError(err);
      });
    res.status(201).json({ variant: await fetchVariant(db, rows[0].variant_id) });
  } catch (err) {
    next(err);
  }
});

// Only prices and the default supplier can change. SKU, product, fabric, size and colour are locked after creation.
variantsRouter.patch('/:id', async (req, res, next) => {
  try {
    const variantId = id('variant').parse(req.params.id);
    const v = updateSchema.parse(req.body);
    const db = getDb(req);
    const result = await db
      .query(
        `UPDATE product_variant SET unit_cost = $2, list_price = $3, default_supplier_id = $4
          WHERE variant_id = $1 RETURNING variant_id`,
        [variantId, v.unit_cost, v.list_price, v.default_supplier_id],
      )
      .catch((err) => {
        throw friendlyInsertError(err);
      });
    if (result.rowCount === 0) throw new UserError('That variant was not found.', 404);
    res.json({ variant: await fetchVariant(db, variantId) });
  } catch (err) {
    next(err);
  }
});

// Variants are never deleted, only hidden. Only the owner can hide or show them.
for (const [action, flag] of [['deactivate', false], ['activate', true]]) {
  variantsRouter.post(`/:id/${action}`, requireRole('owner'), async (req, res, next) => {
    try {
      const variantId = id('variant').parse(req.params.id);
      const db = getDb(req);
      const result = await db.query('UPDATE product_variant SET is_active = $2 WHERE variant_id = $1', [variantId, flag]);
      if (result.rowCount === 0) throw new UserError('That variant was not found.', 404);
      res.json({ variant: await fetchVariant(db, variantId) });
    } catch (err) {
      next(err);
    }
  });
}
