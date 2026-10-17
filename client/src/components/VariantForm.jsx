import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { toPaise } from '../money.js';
import AddValueDialog from './AddValueDialog.jsx';
import MarginLine from './MarginLine.jsx';

const EMPTY = { product_id: '', fabric: '', size: '', colour: '', unit_cost: '', list_price: '', default_supplier_id: '', sku: '' };

function SelectField({ id, label, value, onChange, options, onAdd, disabled }) {
  return (
    <div className="field">
      <div className="label-row">
        <label htmlFor={id}>{label}</label>
        {onAdd && !disabled && (
          <button type="button" className="linkbtn" onClick={onAdd}>+ Add new</button>
        )}
      </div>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} required>
        <option value="">Choose...</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function MoneyField({ id, label, value, onChange }) {
  const invalid = value !== '' && toPaise(value) === null;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="money-input">
        <span aria-hidden="true">₹</span>
        <input id={id} type="text" inputMode="decimal" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0.00" required />
      </div>
      {invalid && <div className="hint bad-text">Enter 0 or more, with at most 2 decimals (for example 450 or 450.50).</div>}
    </div>
  );
}

// Used for both "Add variant" (variant is undefined) and "Edit variant".
export default function VariantForm({ variant, lookups, addValue, addProduct, onSaved, onCancel }) {
  const editing = Boolean(variant);
  const [form, setForm] = useState(
    editing
      ? {
          product_id: variant.product_id,
          fabric: variant.fabric,
          size: variant.size,
          colour: variant.colour,
          unit_cost: variant.unit_cost,
          list_price: variant.list_price,
          default_supplier_id: variant.default_supplier_id || '',
          sku: variant.sku,
        }
      : EMPTY,
  );
  const [skuTouched, setSkuTouched] = useState(false);
  const [dialog, setDialog] = useState(null); // 'product' | 'fabrics' | 'sizes' | 'colours'
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (field) => (value) => setForm((f) => ({ ...f, [field]: value }));

  // Suggest a SKU as soon as product, fabric, size and colour are chosen (until the person types their own).
  useEffect(() => {
    if (editing || skuTouched) return undefined;
    const { product_id, fabric, size, colour } = form;
    if (!product_id || !fabric || !size || !colour) return undefined;
    let stale = false;
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ product_id, fabric, size, colour });
        const data = await api(`/variants/suggest-sku?${params}`);
        if (!stale) setForm((f) => ({ ...f, sku: data.sku }));
      } catch {
        // a missing suggestion is not a problem: the person can type the SKU
      }
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [editing, skuTouched, form.product_id, form.fabric, form.size, form.colour]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(addAnother) {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const body = {
        unit_cost: form.unit_cost,
        list_price: form.list_price,
        default_supplier_id: form.default_supplier_id || null,
      };
      const data = editing
        ? await api(`/variants/${variant.variant_id}`, { method: 'PATCH', body })
        : await api('/variants', {
            method: 'POST',
            body: { ...body, product_id: form.product_id, fabric: form.fabric, size: form.size, colour: form.colour, sku: form.sku },
          });
      if (addAnother) {
        setNotice(`Saved ${data.variant.sku}. You can add the next one.`);
        setForm((f) => ({ ...f, size: '', colour: '', sku: '' }));
        setSkuTouched(false);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        onSaved(data.variant);
      }
    } catch (err) {
      setError(err.message);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setBusy(false);
    }
  }

  const productOptions = lookups.products.map((p) => ({ value: p.id, label: p.name }));
  const plain = (list) => list.map((x) => ({ value: x, label: x }));
  const productName = editing ? variant.product_name : '';

  return (
    <form
      className="card form-card"
      onSubmit={(e) => {
        e.preventDefault();
        save(false);
      }}
    >
      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <div className="alert ok" role="status">{notice}</div>}

      {editing && (
        <div className="alert warn">
          The product, fabric, size, colour and SKU cannot be changed after saving. If one of them is wrong, hide this
          variant and add a new one.
        </div>
      )}

      <div className="form-grid">
        {editing ? (
          <>
            <div className="field"><label>Product</label><input type="text" value={productName} disabled /></div>
            <div className="field"><label>Fabric</label><input type="text" value={form.fabric} disabled /></div>
            <div className="field"><label>Size</label><input type="text" value={form.size} disabled /></div>
            <div className="field"><label>Colour</label><input type="text" value={form.colour} disabled /></div>
          </>
        ) : (
          <>
            <SelectField id="product" label="Product" value={form.product_id} onChange={set('product_id')} options={productOptions} onAdd={() => setDialog('product')} />
            <SelectField id="fabric" label="Fabric" value={form.fabric} onChange={set('fabric')} options={plain(lookups.fabrics)} onAdd={() => setDialog('fabrics')} />
            <SelectField id="size" label="Size" value={form.size} onChange={set('size')} options={plain(lookups.sizes)} onAdd={() => setDialog('sizes')} />
            <SelectField id="colour" label="Colour" value={form.colour} onChange={set('colour')} options={plain(lookups.colours)} onAdd={() => setDialog('colours')} />
          </>
        )}

        <MoneyField id="unit-cost" label="Unit cost (what you pay)" value={form.unit_cost} onChange={set('unit_cost')} />
        <MoneyField id="list-price" label="List price (what you sell for)" value={form.list_price} onChange={set('list_price')} />
      </div>

      <MarginLine listPrice={form.list_price} unitCost={form.unit_cost} />
      {editing && (
        <div className="hint">Changing a price affects new orders only. Existing orders keep the cost they were created with.</div>
      )}

      <div className="form-grid top-gap">
        <div className="field">
          <label htmlFor="supplier">Default supplier (optional)</label>
          <select id="supplier" value={form.default_supplier_id} onChange={(e) => set('default_supplier_id')(e.target.value)}>
            <option value="">None</option>
            {lookups.suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sku">SKU</label>
          <input
            id="sku"
            type="text"
            value={form.sku}
            disabled={editing}
            autoComplete="off"
            onChange={(e) => {
              setSkuTouched(true);
              set('sku')(e.target.value.toUpperCase());
            }}
            required
          />
          {!editing && <div className="hint">Suggested automatically from your choices. You can change it. It must be unique.</div>}
        </div>
      </div>

      <div className="actions">
        <button type="button" className="btn secondary" onClick={onCancel}>Cancel</button>
        {!editing && (
          <button type="button" className="btn secondary" disabled={busy} onClick={() => save(true)}>Save and add another</button>
        )}
        <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
      </div>

      {dialog === 'product' && (
        <AddValueDialog
          title="Add a new product"
          label="Product name"
          placeholder="e.g. Anarkali Gown"
          onClose={() => setDialog(null)}
          onSave={async (name) => set('product_id')(await addProduct(name))}
        />
      )}
      {dialog === 'fabrics' && (
        <AddValueDialog title="Add a new fabric" label="Fabric" placeholder="e.g. Silk" onClose={() => setDialog(null)} onSave={async (name) => set('fabric')(await addValue('fabrics', name))} />
      )}
      {dialog === 'sizes' && (
        <AddValueDialog title="Add a new size" label="Size" placeholder="e.g. 5XL" onClose={() => setDialog(null)} onSave={async (name) => set('size')(await addValue('sizes', name))} />
      )}
      {dialog === 'colours' && (
        <AddValueDialog title="Add a new colour" label="Colour" placeholder="e.g. Teal" onClose={() => setDialog(null)} onSave={async (name) => set('colour')(await addValue('colours', name))} />
      )}
    </form>
  );
}
