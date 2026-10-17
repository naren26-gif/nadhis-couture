import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import Modal from './Modal.jsx';

// Pop-up to send a parcel from an order. Quick buttons fill the quantities; you can also type them line by line,
// and add items from the same customer's other orders to make ONE combined parcel.
export default function ShipDialog({ order, onDone, onClose }) {
  const [data, setData] = useState(null);
  const [qty, setQty] = useState({}); // order_item_id -> text
  const [form, setForm] = useState({ courier_id: '', courier_cost: '', shipping_charge: '', tracking_number: '', shipped_on: '', bill_order_id: '' });
  const [showOthers, setShowOthers] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/shipments/candidates?order_id=${order.id}`)
      .then((d) => {
        setData(d);
        setForm((f) => ({ ...f, courier_id: d.default_courier_id || '', shipped_on: d.today }));
        // start with what is in stock for THIS order (shared stock is handed out line by line)
        setQty(allocateInStock(d.lines.filter((l) => l.this_order)));
      })
      .catch((err) => setError(err.message));
  }, [order.id]);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const mine = data?.lines.filter((l) => l.this_order) ?? [];
  const others = data?.lines.filter((l) => !l.this_order) ?? [];

  const chosen = useMemo(
    () => (data?.lines ?? []).map((l) => ({ line: l, n: /^\d+$/.test(qty[l.order_item_id] ?? '') ? Number(qty[l.order_item_id]) : 0 })).filter((x) => x.n > 0),
    [data, qty],
  );
  const pieces = chosen.reduce((sum, x) => sum + x.n, 0);
  const includedOrders = [...new Map(chosen.map((x) => [x.line.order_id, x.line])).values()].sort((a, b) =>
    (a.order_date + a.order_code).localeCompare(b.order_date + b.order_code));

  // lines that share one product share its stock: hand it out in order
  function allocateInStock(lines) {
    const left = {};
    const out = {};
    for (const l of lines) {
      left[l.sku] = left[l.sku] ?? l.on_hand;
      const n = Math.max(Math.min(l.remaining, left[l.sku]), 0);
      left[l.sku] -= n;
      out[l.order_item_id] = n > 0 ? String(n) : '';
    }
    return out;
  }
  const fillInStock = () => setQty(allocateInStock(mine));
  const fillAll = () => setQty(Object.fromEntries(mine.map((l) => [l.order_item_id, String(l.remaining)])));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = {
        lines: chosen.map((x) => ({ order_item_id: x.line.order_item_id, quantity: x.n })),
        courier_id: form.courier_id,
        shipped_on: form.shipped_on,
        courier_cost: form.courier_cost === '' ? '0' : form.courier_cost,
        shipping_charge: form.shipping_charge === '' ? '0' : form.shipping_charge,
        tracking_number: form.tracking_number,
      };
      if (includedOrders.length > 1) body.bill_order_id = form.bill_order_id || includedOrders[0].order_id;
      const { shipment } = await api('/shipments', { method: 'POST', body });
      onDone(`Parcel ${shipment.code} sent (${shipment.units} ${shipment.units === 1 ? 'piece' : 'pieces'}). Stock updated.`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const lineRow = (l) => (
    <div className="field" key={l.order_item_id}>
      <label htmlFor={`s-${l.order_item_id}`}>
        {l.sku} <span className="muted">&ndash; {l.remaining} left to ship, {l.on_hand} in stock</span>
      </label>
      <input id={`s-${l.order_item_id}`} type="text" inputMode="numeric" value={qty[l.order_item_id] ?? ''} placeholder="0"
        onChange={(e) => setQty((q) => ({ ...q, [l.order_item_id]: e.target.value.trim() }))} />
      {(Number(qty[l.order_item_id]) || 0) > l.on_hand && <div className="hint bad-text">More than is in stock ({l.on_hand}).</div>}
    </div>
  );

  return (
    <Modal title={`Ship from ${order.code}`} onClose={onClose}>
      <form onSubmit={submit}>
        {error && <div className="alert error" role="alert">{error}</div>}
        {!data && !error && <div className="loading">Loading...</div>}
        {data && !data.order.can_ship && <div className="alert warn">This order has already been fully shipped.</div>}
        {data && data.order.can_ship && (
          <>
            <div className="badge-row">
              <button type="button" className="btn secondary small" onClick={fillInStock}>Fill with what's in stock</button>
              <button type="button" className="btn secondary small" onClick={fillAll}>Fill with everything left</button>
            </div>
            <h3 className="dialog-h">Items in this parcel</h3>
            {mine.length === 0 && <p className="muted">Nothing is left to ship on this order.</p>}
            {mine.map(lineRow)}

            {others.length > 0 && (
              <>
                {!showOthers ? (
                  <button type="button" className="linkbtn" onClick={() => setShowOthers(true)}>
                    + Add items from {data.order.customer_name}'s other orders ({others.length} {others.length === 1 ? 'line' : 'lines'})
                  </button>
                ) : (
                  <>
                    <h3 className="dialog-h">From {data.order.customer_name}'s other orders</h3>
                    {others.map((l) => (
                      <div key={l.order_item_id}>
                        <div className="muted">{l.order_code}</div>
                        {lineRow(l)}
                      </div>
                    ))}
                  </>
                )}
              </>
            )}

            <h3 className="dialog-h">Parcel details</h3>
            <div className="field">
              <label htmlFor="sh-courier">Courier</label>
              <select id="sh-courier" value={form.courier_id} onChange={set('courier_id')}>
                <option value="">Choose...</option>
                {data.couriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="sh-charge">Shipping charge to the customer</label>
                <div className="money-input"><span>₹</span><input id="sh-charge" type="text" inputMode="decimal" value={form.shipping_charge} onChange={set('shipping_charge')} placeholder="0" /></div>
                <div className="hint">For this parcel only. It is added to the order that carries it.</div>
              </div>
              <div className="field">
                <label htmlFor="sh-cost">Courier cost (what you will pay)</label>
                <div className="money-input"><span>₹</span><input id="sh-cost" type="text" inputMode="decimal" value={form.courier_cost} onChange={set('courier_cost')} placeholder="0" /></div>
              </div>
            </div>
            {includedOrders.length > 1 && (
              <div className="field">
                <label htmlFor="sh-bill">Charge the shipping on which order?</label>
                <select id="sh-bill" value={form.bill_order_id || includedOrders[0].order_id} onChange={set('bill_order_id')}>
                  {includedOrders.map((o) => <option key={o.order_id} value={o.order_id}>{o.order_code}</option>)}
                </select>
              </div>
            )}
            <div className="form-grid">
              <div className="field">
                <label htmlFor="sh-track">Tracking number (optional)</label>
                <input id="sh-track" type="text" value={form.tracking_number} onChange={set('tracking_number')} maxLength={60} />
              </div>
              <div className="field">
                <label htmlFor="sh-date">Ship date</label>
                <input id="sh-date" type="date" value={form.shipped_on} max={data.today} onChange={set('shipped_on')} />
              </div>
            </div>
            <p className="muted">This parcel: <strong>{pieces}</strong> {pieces === 1 ? 'piece' : 'pieces'}{includedOrders.length > 1 && <> from {includedOrders.length} orders</>}.</p>
          </>
        )}
        <div className="actions">
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={busy || !data || !data.order.can_ship || pieces === 0 || !form.courier_id}>{busy ? 'Saving...' : 'Send parcel'}</button>
        </div>
      </form>
    </Modal>
  );
}
