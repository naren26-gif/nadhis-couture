import { useMemo, useState } from 'react';

// Pick one product variant from a long list: type to narrow it down, then choose. `variants` come from GET /variants.
export default function VariantPicker({ id, variants, value, onChange, takenIds = [], disabled = false }) {
  const [filter, setFilter] = useState('');

  const options = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    return variants.filter((v) => {
      if (v.variant_id === value) return true; // the current choice always stays in the list
      if (takenIds.includes(v.variant_id)) return false;
      const hay = `${v.sku} ${v.product_name} ${v.fabric} ${v.size} ${v.colour}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [variants, filter, value, takenIds]);

  return (
    <div>
      {!disabled && (
        <input
          type="search"
          aria-label="Search products"
          placeholder="Type to search SKU, product or colour"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} style={disabled ? undefined : { marginTop: 6 }}>
        <option value="">{options.length === 0 ? 'No product matches' : 'Choose a product...'}</option>
        {options.map((v) => (
          <option key={v.variant_id} value={v.variant_id}>
            {v.sku} - {v.product_name}, {v.fabric}, {v.size}, {v.colour}
          </option>
        ))}
      </select>
    </div>
  );
}
