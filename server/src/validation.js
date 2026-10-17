// Input checks shared by the screens that take dates, money and quantities (purchases, orders).
// Every message is plain English and safe to show to users.
import { z } from 'zod';
import { parseMoney } from './money.js';

export const uuid = (message) => z.string({ required_error: message }).uuid(message);

export function todayInIndia() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
}

export const dateField = (label) =>
  z
    .string({ required_error: `Please enter the ${label}.` })
    .refine((text) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
      const d = new Date(`${text}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
    }, `Please enter a valid ${label}.`)
    .refine((text) => text <= todayInIndia(), `The ${label} cannot be in the future.`);

// "450" / "450.5" / "450.50" -> Decimal. positive: true means it must be above 0.
export const moneyField = (label, { positive }) =>
  z
    .string({ required_error: `Please enter the ${label}.` })
    .transform((text, ctx) => {
      const value = parseMoney(text);
      if (!value || (positive && value.lte(0))) {
        ctx.addIssue({
          code: 'custom',
          message: `The ${label} must be a number${positive ? ' above 0' : ', 0 or more'}, with at most 2 decimals (for example 450 or 450.50).`,
        });
        return z.NEVER;
      }
      return value;
    });

export const optionalText = (max, label) =>
  z
    .union([z.string().trim().max(max, `The ${label} is too long (${max} characters at most).`), z.literal(''), z.null()])
    .optional()
    .transform((value) => value || null);

export const quantity = z
  .number({ required_error: 'Please enter the quantity.', invalid_type_error: 'The quantity must be a whole number, 1 or more.' })
  .int('The quantity must be a whole number, 1 or more.')
  .min(1, 'The quantity must be a whole number, 1 or more.')
  .max(100000, 'That quantity is too large.');
