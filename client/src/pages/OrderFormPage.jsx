import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { formatInr, toPaise } from '../money.js';
import Modal from '../components/Modal.jsx';
import VariantPicker from '../components/VariantPicker.jsx';

const todayInIndia = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
let nextKey = 1;
const newLine = () => ({ key: nextKey++, item_id: null, variant_id: '', quantity: '', unit_price: '', discount: '', shipped: 0 });

// Small pop-up to add a customer without leaving the order form.
function QuickCustomerDialog({ onSaved, onClose }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    e.stopPropagation(); // this pop-up is drawn on top of the order form: do not also save the order
    setError('');
    setBusy(true);
    try {
      const { item } = await api('/customers', { method: 'POST', body: { name, phone } });
      onSaved(item);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Add a customer" onClose={onClose}>
      <form onSubmit={submit}>
        {error && <div className="alert error" role="alert">{error}</div>}
        <div className="field">
          <label htmlFor="qc-name">Name</label>
          <input id="qc-name" type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus required />
        </div>
        <div className="field">
          <label htmlFor="qc-phone">Phone (optional)</label>
          <input id="qc-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} />
        </div>
        <div className="actions">
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving...' : 'Add customer'}</button>
        </div>
      </form>
    </Modal>
  );
}

// "New order" (/orders/new) and "Edit order" (/orders/:id/edit)
export default function OrderFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();

  const [lookups, setLookups] = useState(null);
  const [variants, setVariants] = useState(null);
  const [form, setForm] = useState({ customer_id: '', order_date: todayInIndia(), notes: '' });
  const [lines, setLines] = useState([newLine()]);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [removedNote, setRemovedNote] = useState(false);
  const [paid, setPaid] = useState(null); // what the customer has already paid and been charged for shipping (edit only)

  useEffect(() => {
    (async () => {
      try {
        const [lk, vs] = await Promise.all([api('/orders/lookups'), api('/variants')]);
        setLookups(lk);
        setVariants(vs.variants);
        if (editing) {
          const { order: o } = await api(`/orders/${id}`);
          if (!o.editable) throw new Error(`This order is already ${o.status.toLowerCase()}, so it can't be edited.`);
          setCode(o.code);
          setPaid({ received: o.received, shipping: o.shipping_charged });
          setForm({ customer_id: o.customer_id || '', order_date: o.order_date, notes: o.notes || '' });
          // products on this order that have since been hidden must still show up in their dropdown
          const known = new Set(vs.variants.map((v) => v.variant_id));
          const extra = o.lines.filter((l) => !known.has(l.variant_id)).map((l) => ({ ...l, unit_cost: l.unit_cost_snapshot }));
          if (extra.length) setVariants([...vs.variants, ...extra]);
          setLines(o.lines.map((l) => ({
            key: nextKey++, item_id: l.item_id, variant_id: l.variant_id, quantity: String(l.quantity),
            unit_price: l.unit_price, discount: l.discount, shipped: l.shipped,
          })));
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [editing, id]);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const setLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const variantOf = (variantId) => variants?.find((v) => v.variant_id === variantId);

  const pickVariant = (key, variantId) => {
    const v = variantOf(variantId);
    setLine(key, { variant_id: variantId, unit_price: v ? v.list_price : '', discount: '' });
  };

  // live numbers in whole paise (no floating point money)
  const figures = useMemo(
    () => lines.map((l) => {
      const qty = /^\d+$/.test(l.quantity) ? Number(l.quantity) : null;
      const price = toPaise(l.unit_price);
      const discount = l.discount === '' ? 0 : toPaise(l.discount);
      if (qty === null || price === null || discount === null) return null;
      const total = qty * price - discount;
      const v = variants?.find((x) => x.variant_id === l.variant_id);
      const cost = v ? toPaise(v.unit_cost) : null;
      return { total, profit: cost === null ? null : total - qty * cost };
    }),
    [lines, variants],
  );
  const grandTotal = figures.reduce((sum, f) => sum + (f?.total ?? 0), 0);

  // editing a paid order down leaves money to give back: say so before saving
  const receivedPaise = paid ? toPaise(paid.received) ?? 0 : 0;
  const newOrderPaise = grandTotal + (paid ? toPaise(paid.shipping) ?? 0 : 0);
  const creditAfterSave = Math.max(receivedPaise - newOrderPaise, 0);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = {
        customer_id: form.customer_id,
        order_date: form.order_date,
        notes: form.notes,
        lines: lines.map((l) => ({
          ...(l.item_id ? { item_id: l.item_id } : {}),
          variant_id: l.variant_id,
          quantity: /^\d+$/.test(l.quantity) ? Number(l.quantity) : 0,
          ...(l.unit_price !== '' ? { unit_price: l.unit_price } : {}),
          discount: l.discount === '' ? '0' : l.discount,
        })),
      };
      const { order } = await api(editing ? `/orders/${id}` : '/orders', { method: editing ? 'PATCH' : 'POST', body });
      navigate(`/orders/${order.id}`, { state: { flash: editing ? `Saved ${order.code}.` : `Created ${order.code}.` } });
    } catch (err) {
      setError(err.message);
      setBusy(false);
      window.scrollTo({ top: 0 });
    }
  }

  const taken = lines.map((l) => l.variant_id).filter(Boolean);

  return (
    <>
      <p><Link to={editing ? `/orders/${id}` : '/orders'}>&larr; Back</Link></p>
      <h1>{editing ? `Edit ${code}` : 'New order'}</h1>
      {error && <div className="alert error" role="alert">{error}</div>}
      {loading && <div className="loading">Loading...</div>}

      {!loading && lookups && variants && (editing ? code : true) && (
        <form className="card form-card" onSubmit={submit} noValidate>
          <div className="form-grid">
            <div className="field">
              <div className="label-row">
                <label htmlFor="customer">Customer</label>
                <button type="button" className="linkbtn" onClick={() => setAddingCustomer(true)}>+ Add new customer</button>
              </div>
              <select id="customer" value={form.customer_id} onChange={set('customer_id')}>
                <option value="">Walk-in customer (no name)</option>
                {form.customer_id && !lookups.customers.some((c) => c.id === form.customer_id) && <option value={form.customer_id}>(current customer, hidden)</option>}
                {lookups.customers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="date">Order date</label>
              <input id="date" type="date" value={form.order_date} max={todayInIndia()} onChange={set('order_date')} required />
            </div>
          </div>
          <div className="field">
            <label htmlFor="notes">Notes (optional)</label>
            <input id="notes" type="text" value={form.notes} onChange={set('notes')} maxLength={500} />
          </div>

          <h2>Products</h2>
          {lines.map((l, i) => {
            const locked = l.shipped > 0;
            const v = variantOf(l.variant_id);
            const qty = /^\d+$/.test(l.quantity) ? Number(l.quantity) : 0;
            const toShip = qty - l.shipped;
            const f = figures[i];
            return (
              <div className="card line-card" key={l.key}>
                <div className="field">
                  <label htmlFor={`v-${l.key}`}>Product {i + 1}</label>
                  <VariantPicker id={`v-${l.key}`} variants={variants} value={l.variant_id} takenIds={taken} disabled={locked} onChange={(val) => pickVariant(l.key, val)} />
                  {locked && <div className="hint">{l.shipped} already shipped, so the product, price and discount are locked.</div>}
                  {v && !locked && v.on_hand !== undefined && toShip > v.on_hand && (
                    <div className="hint bad-text">
                      {v.on_hand <= 0 ? 'Out of stock.' : `Only ${v.on_hand} in stock.`} You can still take this order; the rest ships after you restock.
                    </div>
                  )}
                  {v && !locked && v.on_hand !== undefined && toShip <= v.on_hand && <div className="hint">{v.on_hand} in stock.</div>}
                </div>
                <div className="form-grid">
                  <div className="field">
                    <label htmlFor={`q-${l.key}`}>Quantity</label>
                    <input id={`q-${l.key}`} type="text" inputMode="numeric" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value.trim() })} />
                    {locked && <div className="hint">At least {l.shipped}.</div>}
                  </div>
                  <div className="field">
                    <label htmlFor={`p-${l.key}`}>Price per piece</label>
                    <div className="money-input"><span>₹</span><input id={`p-${l.key}`} type="text" inputMode="decimal" value={l.unit_price} disabled={locked} onChange={(e) => setLine(l.key, { unit_price: e.target.value.trim() })} /></div>
                    <div className="hint">Filled in from the list price; change it for a special price.</div>
                  </div>
                  <div className="field">
                    <label htmlFor={`d-${l.key}`}>Discount on this line (optional)</label>
                    <div className="money-input"><span>₹</span><input id={`d-${l.key}`} type="text" inputMode="decimal" value={l.discount} disabled={locked} onChange={(e) => setLine(l.key, { discount: e.target.value.trim() })} /></div>
                    <div className="hint">Total rupees off for this line, not per piece.</div>
                  </div>
                </div>
                <div className="line-foot">
                  <span>
                    Line total: <strong>{f ? formatInr(f.total) : '-'}</strong>
                    {f && f.profit !== null && <span className={f.profit < 0 ? 'bad-text' : 'muted'}> &middot; profit {formatInr(f.profit)}</span>}
                  </span>
                  {!locked && lines.length > 1 && (
                    <button type="button" className="linkbtn" onClick={() => { setLines((ls) => ls.filter((x) => x.key !== l.key)); if (l.item_id) setRemovedNote(true); }}>Remove this line</button>
                  )}
                </div>
              </div>
            );
          })}
          <button type="button" className="btn secondary" onClick={() => setLines((ls) => [...ls, newLine()])}>+ Add another product</button>
          {removedNote && <div className="alert warn top-gap-sm">A removed line is deleted when you press Save.</div>}
          {creditAfterSave > 0 && (
            <div className="alert warn top-gap-sm">
              The customer has already paid <strong>{formatInr(receivedPaise)}</strong>. After this change the order is worth{' '}
              <strong>{formatInr(newOrderPaise)}</strong>, so <strong>{formatInr(creditAfterSave)}</strong> will be credit you owe the customer.
              You can pay it back with "Refund customer" on the order page.
            </div>
          )}
          <div className="margin-line good total-line">Order total (products): <strong>{formatInr(grandTotal)}</strong><span className="muted"> &middot; shipping is added when parcels are sent</span></div>

          <div className="actions">
            <button type="button" className="btn secondary" onClick={() => navigate(editing ? `/orders/${id}` : '/orders')}>Cancel</button>
            <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving...' : 'Save order'}</button>
          </div>
        </form>
      )}

      {addingCustomer && (
        <QuickCustomerDialog
          onClose={() => setAddingCustomer(false)}
          onSaved={(item) => {
            setLookups((lk) => ({ ...lk, customers: [...lk.customers, { id: item.id, code: item.code, name: item.name, phone: item.phone }].sort((a, b) => a.name.localeCompare(b.name)) }));
            setForm((f) => ({ ...f, customer_id: item.id }));
            setAddingCustomer(false);
          }}
        />
      )}
    </>
  );
}
