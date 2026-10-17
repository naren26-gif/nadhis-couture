import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { formatInr, toPaise } from '../money.js';
import VariantPicker from '../components/VariantPicker.jsx';

const todayInIndia = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
let nextKey = 1;
const newLine = () => ({ key: nextKey++, item_id: null, variant_id: '', quantity: '', unit_cost: '', received: 0 });

// "New purchase" (/purchases/new) and "Edit purchase" (/purchases/:id/edit)
export default function PurchaseFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();

  const [lookups, setLookups] = useState(null);
  const [variants, setVariants] = useState(null);
  const [form, setForm] = useState({ supplier_id: '', order_date: todayInIndia(), purchase_type: '', notes: '', total: '' });
  const [lines, setLines] = useState([newLine()]);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [lk, vs] = await Promise.all([api('/purchases/lookups'), api('/variants')]);
        setLookups(lk);
        setVariants(vs.variants);
        if (editing) {
          const { purchase: p } = await api(`/purchases/${id}`);
          // products on this purchase that have since been hidden must still show up in their dropdown
          const known = new Set(vs.variants.map((v) => v.variant_id));
          const extra = p.lines.filter((l) => !known.has(l.variant_id)).map((l) => ({ ...l, product_name: l.product_name, unit_cost: l.unit_cost }));
          if (extra.length) setVariants([...vs.variants, ...extra]);
          setCode(p.code);
          setForm({ supplier_id: p.supplier_id, order_date: p.order_date, purchase_type: p.purchase_type, notes: p.notes || '', total: p.affects_stock ? '' : p.total_amount });
          setLines(p.lines.map((l) => ({ key: nextKey++, item_id: l.item_id, variant_id: l.variant_id, quantity: String(l.qty_ordered), unit_cost: l.unit_cost, received: l.qty_received })));
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [editing, id]);

  const affectsStock = lookups?.types.find((t) => t.name === form.purchase_type)?.affects_stock ?? false;
  const typeChosen = Boolean(form.purchase_type);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const setLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const pickVariant = (key, variantId) => {
    const v = variants.find((x) => x.variant_id === variantId);
    setLine(key, { variant_id: variantId, unit_cost: v ? v.unit_cost : '' });
  };

  // live totals in whole paise (no floating point money)
  const lineTotals = useMemo(
    () => lines.map((l) => {
      const qty = /^\d+$/.test(l.quantity) ? Number(l.quantity) : null;
      const cost = toPaise(l.unit_cost);
      return qty !== null && cost !== null ? qty * cost : null;
    }),
    [lines],
  );
  const grandTotal = lineTotals.reduce((sum, t) => sum + (t ?? 0), 0);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = { supplier_id: form.supplier_id, order_date: form.order_date, notes: form.notes };
      if (affectsStock) {
        body.lines = lines.map((l) => ({
          ...(l.item_id ? { item_id: l.item_id } : {}),
          variant_id: l.variant_id,
          quantity: /^\d+$/.test(l.quantity) ? Number(l.quantity) : 0,
          ...(l.unit_cost !== '' ? { unit_cost: l.unit_cost } : {}),
        }));
      } else {
        body.total = form.total;
      }
      if (!editing) body.purchase_type = form.purchase_type;
      const { purchase } = await api(editing ? `/purchases/${id}` : '/purchases', { method: editing ? 'PATCH' : 'POST', body });
      navigate(`/purchases/${purchase.id}`, { state: { flash: editing ? `Saved ${purchase.code}.` : `Created ${purchase.code}. Record the stock when it arrives.` } });
    } catch (err) {
      setError(err.message);
      setBusy(false);
      window.scrollTo({ top: 0 });
    }
  }

  const taken = lines.map((l) => l.variant_id).filter(Boolean);

  return (
    <>
      <p><Link to={editing ? `/purchases/${id}` : '/purchases'}>&larr; Back</Link></p>
      <h1>{editing ? `Edit ${code}` : 'New purchase'}</h1>
      {error && <div className="alert error" role="alert">{error}</div>}
      {loading && <div className="loading">Loading...</div>}

      {!loading && lookups && variants && (
        <form className="card form-card" onSubmit={submit} noValidate>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="supplier">Supplier</label>
              <select id="supplier" value={form.supplier_id} onChange={set('supplier_id')} required>
                <option value="">Choose a supplier...</option>
                {form.supplier_id && !lookups.suppliers.some((s) => s.id === form.supplier_id) && <option value={form.supplier_id}>(current supplier, hidden)</option>}
                {lookups.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="date">Purchase date</label>
              <input id="date" type="date" value={form.order_date} max={todayInIndia()} onChange={set('order_date')} required />
            </div>
            <div className="field">
              <label htmlFor="type">Type of purchase</label>
              <select id="type" value={form.purchase_type} onChange={set('purchase_type')} disabled={editing} required>
                <option value="">Choose a type...</option>
                {lookups.types.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
              {editing && <div className="hint">The type can't be changed after saving.</div>}
              {typeChosen && !editing && <div className="hint">{affectsStock ? 'Stock is added when the goods are received.' : 'This type does not add stock.'}</div>}
            </div>
            <div className="field">
              <label htmlFor="notes">Notes (optional)</label>
              <input id="notes" type="text" value={form.notes} onChange={set('notes')} maxLength={500} />
            </div>
          </div>

          {typeChosen && !affectsStock && (
            <div className="field">
              <label htmlFor="total">Total amount</label>
              <div className="money-input"><span>₹</span><input id="total" type="text" inputMode="decimal" value={form.total} onChange={set('total')} /></div>
            </div>
          )}

          {typeChosen && affectsStock && (
            <>
              <h2>Products</h2>
              {lines.map((l, i) => {
                const locked = l.received > 0;
                return (
                  <div className="card line-card" key={l.key}>
                    <div className="field">
                      <label htmlFor={`v-${l.key}`}>Product {i + 1}</label>
                      <VariantPicker id={`v-${l.key}`} variants={variants} value={l.variant_id} takenIds={taken} disabled={locked} onChange={(v) => pickVariant(l.key, v)} />
                      {locked && <div className="hint">{l.received} already received, so the product and cost are locked.</div>}
                    </div>
                    <div className="form-grid">
                      <div className="field">
                        <label htmlFor={`q-${l.key}`}>Quantity</label>
                        <input id={`q-${l.key}`} type="text" inputMode="numeric" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value.trim() })} />
                        {locked && <div className="hint">At least {l.received}.</div>}
                      </div>
                      <div className="field">
                        <label htmlFor={`c-${l.key}`}>Cost per piece</label>
                        <div className="money-input"><span>₹</span><input id={`c-${l.key}`} type="text" inputMode="decimal" value={l.unit_cost} disabled={locked} onChange={(e) => setLine(l.key, { unit_cost: e.target.value.trim() })} /></div>
                        <div className="hint">Filled in from the product; change it if this supplier charged differently.</div>
                      </div>
                    </div>
                    <div className="line-foot">
                      <span>Line total: <strong>{lineTotals[i] === null ? '-' : formatInr(lineTotals[i])}</strong></span>
                      {!l.item_id && lines.length > 1 && (
                        <button type="button" className="linkbtn" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>Remove this line</button>
                      )}
                    </div>
                  </div>
                );
              })}
              <button type="button" className="btn secondary" onClick={() => setLines((ls) => [...ls, newLine()])}>+ Add another product</button>
              <div className="margin-line good total-line">Purchase total: <strong>{formatInr(grandTotal)}</strong></div>
            </>
          )}

          <div className="actions">
            <button type="button" className="btn secondary" onClick={() => navigate(editing ? `/purchases/${id}` : '/purchases')}>Cancel</button>
            <button type="submit" className="btn" disabled={busy || !typeChosen}>{busy ? 'Saving...' : 'Save purchase'}</button>
          </div>
        </form>
      )}
    </>
  );
}
