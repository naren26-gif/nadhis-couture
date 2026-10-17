import { describe, expect, it } from 'vitest';
import { formatMoney, margin, marginPercent, parseMoney } from '../src/money.js';

describe('money', () => {
  it('accepts normal amounts and rejects bad ones', () => {
    expect(parseMoney('450').toFixed(2)).toBe('450.00');
    expect(parseMoney('450.5').toFixed(2)).toBe('450.50');
    expect(parseMoney(' 0 ').toFixed(2)).toBe('0.00');
    for (const bad of ['', '-1', 'abc', '1.234', '1,000', '12345678', null, 450, '1e3']) {
      expect(parseMoney(bad)).toBeNull();
    }
  });

  it('computes margin exactly, with no floating-point error', () => {
    expect(formatMoney(margin('499.99', '290.10'))).toBe('209.89');
    expect(formatMoney(margin('0.30', '0.10'))).toBe('0.20'); // 0.3 - 0.1 is 0.19999999999999998 in plain JS
    expect(formatMoney(margin('300.00', '450.00'))).toBe('-150.00');
  });

  it('gives the margin as a percentage of the list price', () => {
    expect(marginPercent('800.00', '450.00')).toBe('43.8');
    expect(marginPercent('0.00', '450.00')).toBeNull();
  });
});
