// Suppliers and customers are almost the same thing (code, name, phone, email, location), so one function builds both
// routers from a small description. Parameterised SQL only: the table and column names below are fixed constants in
// this code, never user input.
import { Router } from 'express';
import { z } from 'zod';
import { getDb, inTransaction } from '../db.js';
import { nextCode } from '../codes.js';
import { requireRole } from '../auth/index.js';
import { UserError } from '../errors.js';

const PHONE = /^[0-9+ ()-]{6,20}$/; // same rule as the database
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const optional = (schema) =>
  z
    .union([schema, z.literal(''), z.null()])
    .optional()
    .transform((value) => (value ? value : null));

const text = (label, max) =>
  optional(z.string().trim().max(max, `The ${label} is too long (${max} characters at most).`));

const PHONE_RULE = 'The phone number can only have digits, spaces, + ( ) - and must be 6 to 20 characters.';
const PINCODE = /^[0-9]{6}$/;

// A text field that must be filled in.
const required = (message, max, label) =>
  z.string({ required_error: message }).trim().min(1, message).max(max, `The ${label} is too long (${max} characters at most).`);

// hasAddress: customers must have a phone number and ONE saved delivery address (suppliers keep phone optional).
export function buildPartyRouter({ noun, table, idColumn, codeColumn, prefix, width, hasContactPerson, hasAddress = false }) {
  const router = Router();
  const idSchema = z.string({ required_error: `Please choose the ${noun}.` }).uuid(`That ${noun} was not found.`);

  const shape = {
    name: z
      .string({ required_error: `Please enter the ${noun}'s name.` })
      .trim()
      .min(1, `Please enter the ${noun}'s name.`)
      .max(100, 'The name is too long (100 characters at most).')
      .transform((value) => value.replace(/\s+/g, ' ')),
    phone: hasAddress
      ? z
          .string({ required_error: 'Please enter the phone number.' })
          .trim()
          .min(1, 'Please enter the phone number.')
          .refine((value) => PHONE.test(value), PHONE_RULE)
      : optional(z.string().trim().refine((value) => PHONE.test(value), PHONE_RULE)),
    email: optional(z.string().trim().max(120, 'The email is too long.').refine((value) => EMAIL.test(value), 'Please enter a valid email address, or leave it empty.')),
    location: text('location', 200),
  };
  if (hasContactPerson) shape.contact_person = text('contact person', 100);
  if (hasAddress) {
    shape.address_line1 = required('Please enter the address (line 1).', 150, 'address');
    shape.address_line2 = text('address (line 2)', 150);
    shape.city = required('Please enter the city.', 80, 'city');
    shape.state = required('Please choose the state.', 60, 'state');
    shape.pincode = z
      .string({ required_error: 'Please enter the PIN code.' })
      .trim()
      .refine((value) => PINCODE.test(value), 'That does not look like a valid PIN code (6 digits).');
  }
  const bodySchema = z.object(shape);

  const fields = [
    'name', 'phone', 'email', 'location',
    ...(hasContactPerson ? ['contact_person'] : []),
    ...(hasAddress ? ['address_line1', 'address_line2', 'city', 'state', 'pincode'] : []),
  ];
  const columns = `${idColumn} AS id, ${codeColumn} AS code, name, ${hasContactPerson ? 'contact_person, ' : ''}phone, email, location, ${
    hasAddress ? 'address_line1, address_line2, city, state, pincode, ' : ''
  }is_active`;
  const addressSearch = hasAddress
    ? `OR strpos(lower(concat_ws(' ', address_line1, address_line2, city, state, pincode)), lower($1)) > 0`
    : '';

  const listQuery = z.object({
    search: z.string().trim().max(80).optional(),
    inactive: z.enum(['true', 'false']).default('false'),
  });

  async function fetchOne(db, id) {
    const { rows } = await db.query(`SELECT ${columns} FROM ${table} WHERE ${idColumn} = $1`, [id]);
    return rows[0] ?? null;
  }

  // A phone number can belong to one person only. Check first so we can say who has it (asking after the database
  // has refused would fail inside the aborted transaction). The database's unique index remains the real guard.
  // Customers compare the LAST 10 DIGITS, so "98765 43210" and "+91 98765-43210" are the same number.
  async function checkPhoneFree(db, phone, exceptId) {
    if (!phone) return;
    const sameNumber = hasAddress
      ? `right(regexp_replace(phone, '\\D', '', 'g'), 10) = right(regexp_replace($1, '\\D', '', 'g'), 10)`
      : 'phone = $1';
    const other = await db.query(
      `SELECT name, ${codeColumn} AS code FROM ${table} WHERE ${sameNumber} AND ${idColumn} IS DISTINCT FROM $2`,
      [phone, exceptId ?? null],
    );
    if (other.rows[0]) {
      throw new UserError(`That phone number already belongs to ${other.rows[0].name} (${other.rows[0].code}).`, 409);
    }
  }

  router.get('/', async (req, res, next) => {
    try {
      const q = listQuery.parse(Object.fromEntries(Object.entries(req.query).filter(([, value]) => value !== '')));
      const { rows } = await getDb(req).query(
        `SELECT ${columns} FROM ${table}
          WHERE ($1::text IS NULL OR strpos(lower(name), lower($1)) > 0 OR strpos(lower(${codeColumn}), lower($1)) > 0
                 OR strpos(COALESCE(phone, ''), $1) > 0 OR strpos(lower(COALESCE(location, '')), lower($1)) > 0
                 ${addressSearch})
            AND ($2::boolean OR is_active)
          ORDER BY lower(name), ${codeColumn}`,
        [q.search ?? null, q.inactive === 'true'],
      );
      res.json({ items: rows });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const item = await fetchOne(getDb(req), idSchema.parse(req.params.id));
      if (!item) throw new UserError(`That ${noun} was not found.`, 404);
      res.json({ item });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const v = bodySchema.parse(req.body);
      const id = await inTransaction(req, async (tx) => {
        await checkPhoneFree(tx, v.phone, null);
        const code = await nextCode(tx, { table, column: codeColumn, prefix, width });
        const { rows } = await tx.query(
          `INSERT INTO ${table} (${codeColumn}, ${fields.join(', ')})
           VALUES ($1, ${fields.map((_, i) => `$${i + 2}`).join(', ')})
           RETURNING ${idColumn} AS id`,
          [code, ...fields.map((f) => v[f])],
        );
        return rows[0].id;
      });
      res.status(201).json({ item: await fetchOne(getDb(req), id) });
    } catch (err) {
      next(err);
    }
  });

  // The code never changes.
  router.patch('/:id', async (req, res, next) => {
    const db = getDb(req);
    try {
      const id = idSchema.parse(req.params.id);
      const v = bodySchema.parse(req.body);
      await checkPhoneFree(db, v.phone, id);
      const result = await db.query(
        `UPDATE ${table} SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')} WHERE ${idColumn} = $1`,
        [id, ...fields.map((f) => v[f])],
      );
      if (result.rowCount === 0) throw new UserError(`That ${noun} was not found.`, 404);
      res.json({ item: await fetchOne(db, id) });
    } catch (err) {
      next(err);
    }
  });

  // Never deleted, only hidden. Only the owner can hide or show.
  for (const [action, flag] of [['deactivate', false], ['activate', true]]) {
    router.post(`/:id/${action}`, requireRole('owner'), async (req, res, next) => {
      try {
        const id = idSchema.parse(req.params.id);
        const db = getDb(req);
        const result = await db.query(`UPDATE ${table} SET is_active = $2 WHERE ${idColumn} = $1`, [id, flag]);
        if (result.rowCount === 0) throw new UserError(`That ${noun} was not found.`, 404);
        res.json({ item: await fetchOne(db, id) });
      } catch (err) {
        next(err);
      }
    });
  }

  return router;
}
