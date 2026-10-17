// Money is INR numeric(12,2). In code it is always a Decimal or a string like "450.00", never a JavaScript float.
import Decimal from 'decimal.js';

export const MAX_MONEY = new Decimal('9999999.99');

const MONEY_PATTERN = /^\d{1,7}(\.\d{1,2})?$/;

// Accepts "450", "450.5", "450.50". Returns a Decimal, or null if it is not a valid amount of 0 or more.
export function parseMoney(text) {
  if (typeof text !== 'string') return null;
  const clean = text.trim();
  if (!MONEY_PATTERN.test(clean)) return null;
  return new Decimal(clean);
}

export function formatMoney(value) {
  return new Decimal(value).toFixed(2);
}

// margin = list price - unit cost (see README: Profit = selling price - unit cost)
export function margin(listPrice, unitCost) {
  return new Decimal(listPrice).minus(new Decimal(unitCost));
}

// Margin as a percentage of the list price (display only). null when the price is 0.
export function marginPercent(listPrice, unitCost) {
  const price = new Decimal(listPrice);
  if (price.isZero()) return null;
  return margin(price, unitCost).div(price).times(100).toDecimalPlaces(1).toString();
}
