import { describe, expect, it } from 'vitest';
import { colourCodeFallback, prefixFallback, suggestSku } from '../src/skus.js';

const UM = 'product-umbrella';
const SK = 'product-kurti';
const existing = [
  { sku: 'UMRC-M-LV', product_id: UM, fabric: 'Rado Crushed', size: 'M', colour: 'Lavender' },
  { sku: 'UMRC-M-PK', product_id: UM, fabric: 'Rado Crushed', size: 'M', colour: 'Pink' },
  { sku: 'UMC-L-YLW', product_id: UM, fabric: 'Cotton', size: 'L', colour: 'Yellow' },
  { sku: 'SKC-L-IVY', product_id: SK, fabric: 'Cotton', size: 'L', colour: 'Ivory' },
];

describe('SKU suggestions', () => {
  it('copies the prefix and colour code the shop already uses', () => {
    const sku = suggestSku({ productId: UM, productName: 'Umbrella Maxi', fabric: 'Rado Crushed', size: 'XL', colour: 'Lavender' }, existing);
    expect(sku).toBe('UMRC-XL-LV');
  });

  it('reuses a colour code from another product', () => {
    const sku = suggestSku({ productId: SK, productName: 'Straight Kurti', fabric: 'Cotton', size: 'M', colour: 'Yellow' }, existing);
    expect(sku).toBe('SKC-M-YLW');
  });

  it('builds a new prefix and colour code from letters for new combinations', () => {
    const sku = suggestSku({ productId: 'new', productName: 'Anarkali Gown', fabric: 'Silk', size: '2XL', colour: 'Maroon' }, existing);
    expect(sku).toBe('AGS-2XL-MRN');
  });

  it('never suggests a SKU that already exists', () => {
    const sku = suggestSku({ productId: UM, productName: 'Umbrella Maxi', fabric: 'Rado Crushed', size: 'M', colour: 'Pink' }, existing);
    expect(sku).toBe('UMRC-M-PK-2');
  });

  it('fallback rules', () => {
    expect(colourCodeFallback('Black')).toBe('BLK');
    expect(colourCodeFallback('Light brown')).toBe('LB');
    expect(prefixFallback('Straight Kurti', 'Banaras')).toBe('SKB');
  });
});
