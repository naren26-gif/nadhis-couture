import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db.js';
import { UserError } from '../errors.js';

export const productsRouter = Router();

const productSchema = z.object({
  name: z
    .string({ required_error: 'Please enter the product name.' })
    .trim()
    .min(1, 'Please enter the product name.')
    .max(80, 'The product name is too long (80 letters at most).'),
});

productsRouter.post('/', async (req, res, next) => {
  try {
    const parsed = productSchema.parse(req.body);
    const name = parsed.name.replace(/\s+/g, ' ');
    const db = getDb(req);
    const exists = await db.query('SELECT 1 FROM product WHERE lower(name) = lower($1)', [name]);
    if (exists.rowCount > 0) throw new UserError('A product with that name already exists.', 409);
    const { rows } = await db.query('INSERT INTO product (name) VALUES ($1) RETURNING product_id AS id, name', [name]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});
