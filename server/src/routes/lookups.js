import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db.js';
import { UserError } from '../errors.js';

export const lookupsRouter = Router();

// Everything the Products form needs for its dropdowns, in one call.
lookupsRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await getDb(req).query(`
      SELECT
        (SELECT COALESCE(json_agg(json_build_object('id', product_id, 'name', name) ORDER BY name), '[]'::json)
           FROM product WHERE is_active) AS products,
        (SELECT COALESCE(json_agg(name ORDER BY name), '[]'::json) FROM fabric_ref) AS fabrics,
        (SELECT COALESCE(json_agg(code ORDER BY sort_order), '[]'::json) FROM size_ref) AS sizes,
        (SELECT COALESCE(json_agg(name ORDER BY name), '[]'::json) FROM colour_ref) AS colours,
        (SELECT COALESCE(json_agg(json_build_object('id', supplier_id, 'name', name) ORDER BY name), '[]'::json)
           FROM supplier WHERE is_active) AS suppliers`);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Tidy what a person typed: trim, collapse repeated spaces, start with a capital letter.
function tidyName(text) {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

const nameSchema = (label) =>
  z.object({
    name: z
      .string({ required_error: `Please enter a ${label}.` })
      .trim()
      .min(1, `Please enter a ${label}.`)
      .max(60, `The ${label} is too long (60 letters at most).`),
  });

// Add a value to a dropdown list, refusing duplicates that differ only by capital letters.
async function addIfNew(db, label, existsSql, insertSql, params) {
  const exists = await db.query(existsSql, [params[0]]);
  if (exists.rowCount > 0) throw new UserError(`That ${label} already exists.`, 409);
  await db.query(insertSql, params);
}

lookupsRouter.post('/fabrics', async (req, res, next) => {
  try {
    const { name } = nameSchema('fabric').parse(req.body);
    const value = tidyName(name);
    await addIfNew(
      getDb(req),
      'fabric',
      'SELECT 1 FROM fabric_ref WHERE lower(name) = lower($1)',
      'INSERT INTO fabric_ref (name) VALUES ($1)',
      [value],
    );
    res.status(201).json({ name: value });
  } catch (err) {
    next(err);
  }
});

lookupsRouter.post('/colours', async (req, res, next) => {
  try {
    const { name } = nameSchema('colour').parse(req.body);
    const value = tidyName(name);
    await addIfNew(
      getDb(req),
      'colour',
      'SELECT 1 FROM colour_ref WHERE lower(name) = lower($1)',
      'INSERT INTO colour_ref (name) VALUES ($1)',
      [value],
    );
    res.status(201).json({ name: value });
  } catch (err) {
    next(err);
  }
});

// A new size goes at the end of the size order.
lookupsRouter.post('/sizes', async (req, res, next) => {
  try {
    const { name } = nameSchema('size').parse(req.body);
    const value = name.replace(/\s+/g, '').toUpperCase();
    if (value.length > 10) throw new UserError('The size is too long (10 characters at most).');
    const db = getDb(req);
    const next_order = await db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM size_ref');
    await addIfNew(
      db,
      'size',
      'SELECT 1 FROM size_ref WHERE lower(code) = lower($1)',
      'INSERT INTO size_ref (code, sort_order) VALUES ($1, $2)',
      [value, next_order.rows[0].n],
    );
    res.status(201).json({ name: value });
  } catch (err) {
    next(err);
  }
});
