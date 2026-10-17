import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { formatInrText } from '../money.js';
import Modal from '../components/Modal.jsx';
import { ShipmentStatusBadge } from '../components/PurchaseBadges.jsx';

const todayInIndia = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

// Pop-up: mark the parcel delivered. This can't be undone, so it asks first.
function DeliveredDialog({ shipment, onDone, onClose }) {
  const [date, setDate] = useState(todayInIndia());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api(`/shipments/${shipment.id}/status`, { method: 'POST', body: { status: 'Delivered', delivered_on: date } });
      onDone(`${shipment.code} marked as delivered.`, res.shipment);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Mark as delivered" onClose={onClose}>
      <form onSubmit={submit}>
        {error && <div className="alert error" role="alert">{error}</div>}
        <p className="muted">Once every parcel of an order is delivered, the order becomes Delivered too. <strong>This cannot be undone.</strong></p>
        <div className="field">
          <label htmlFor="dl-date">Date delivered</label>
          <input id="dl-date" type="date" value={date} min={shipment.shipped_on} max={todayInIndia()} onChange={(e) => setDate(e.target.value)} autoFocus />
        </div>
        <div className="actions">
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={busy || !date}>{busy ? 'Saving...' : 'Yes, it was delivered'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Pop-up: fix details. Anyone can fix tracking and note; only the owner can change money.
function EditDialog({ shipment, isOwner, onDone, onClose }) {
  const [form, setForm] = useState({
    tracking_number: shipment.tracking_number || '', note: shipment.note || '',
    courier_cost: shipment.courier_cost, shipping_charge: shipment.shipping_charged,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = { tracking_number: form.tracking_number, note: form.note };
      // only send money fields that really changed, so a staff member's save never trips the owner-only rule
      if (isOwner && form.courier_cost !== shipment.courier_cost) body.courier_cost = form.courier_cost;
      if (isOwner && form.shipping_charge !== shipment.shipping_charged) body.shipping_charge = form.shipping_charge;
      const res = await api(`/shipments/${shipment.id}`, { method: 'PATCH', body });
      onDone('Saved.', res.shipment);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`Edit ${shipment.code}`} onClose={onClose}>
      <form onSubmit={submit}>
        {error && <div className="alert error" role="alert">{error}</div>}
        <div className="field">
          <label htmlFor="ed-track">Tracking number</label>
          <input id="ed-track" type="text" value={form.tracking_number} onChange={set('tracking_number')} maxLength={60} autoFocus />
        </div>
        <div className="field">
          <label htmlFor="ed-note">Note</label>
          <input id="ed-note" type="text" value={form.note} onChange={set('note')} maxLength={300} />
        </div>
        {isOwner ? (
          <div className="form-grid">
            <div className="field">
              <label htmlFor="ed-charge">Shipping charge to the customer</label>
              <div className="money-input"><span>₹</span><input id="ed-charge" type="text" inputMode="decimal" value={form.shipping_charge} onChange={set('shipping_charge')} /></div>
            </div>
            <div className="field">
              <label htmlFor="ed-cost">Courier cost</label>
              <div className="money-input"><span>₹</span><input id="ed-cost" type="text" inputMode="decimal" value={form.courier_cost} onChange={set('courier_cost')} disabled={shipment.paid_to_courier} /></div>
              {shipment.paid_to_courier && <div className="hint">Already paid to the courier, so it can't change.</div>}
            </div>
          </div>
        ) : (
          <p className="muted">Only the owner can change the money amounts of a parcel.</p>
        )}
        <div className="actions">
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function ShipmentDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [shipment, setShipment] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [dialog, setDialog] = useState(null); // 'delivered' | 'edit'
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setShipment((await api(`/shipments/${id}`)).shipment);
    } catch (err) {
      setError(err.message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!flash) return undefined;
    const timer = setTimeout(() => setFlash(''), 6000);
    return () => clearTimeout(timer);
  }, [flash]);

  async function markInTransit() {
    setBusy(true);
    setError('');
    try {
      const res = await api(`/shipments/${id}/status`, { method: 'POST', body: { status: 'In Transit' } });
      setShipment(res.shipment);
      setFlash(`${res.shipment.code} is now in transit.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const done = (message, updated) => { setDialog(null); setFlash(message); setShipment(updated); };

  if (error && !shipment) return <><p><Link to="/shipping">&larr; Back to shipping</Link></p><div className="alert error" role="alert">{error}</div></>;
  if (!shipment) return <div className="loading">Loading...</div>;

  const delivered = shipment.status === 'Delivered';

  return (
    <>
      <p><Link to="/shipping">&larr; Back to shipping</Link></p>
      <div className="page-head">
        <h1>{shipment.code}</h1>
        <div className="row-actions">
          {shipment.status === 'Shipped' && <button className="btn secondary" disabled={busy} onClick={markInTransit}>Mark in transit</button>}
          {!delivered && <button className="btn" onClick={() => setDialog('delivered')}>Mark delivered</button>}
          <button className="btn secondary" onClick={() => setDialog('edit')}>Edit</button>
        </div>
      </div>

      {flash && <div className="alert ok" role="status">{flash}</div>}
      {error && <div className="alert error" role="alert">{error}</div>}

      <div className="card">
        <div><strong>{shipment.customers.join(', ')}</strong> &middot; {shipment.courier}</div>
        <div className="muted">
          Shipped {shipment.shipped_on}{delivered && <> &middot; delivered {shipment.delivered_on}</>}
          {shipment.tracking_number && <> &middot; tracking {shipment.tracking_number}</>}
        </div>
        {shipment.note && <div className="muted">{shipment.note}</div>}
        <div className="badge-row top-gap-sm">
          <ShipmentStatusBadge status={shipment.status} />
          {shipment.paid_to_courier ? <Link to="/shipping?tab=courier"><span className="badge good">Courier paid ({shipment.settlement_code})</span></Link> : <Link to="/shipping?tab=courier"><span className="badge muted-badge">Courier not paid yet</span></Link>}
        </div>
        <dl className="money-list">
          <div><dt>Charged to customer</dt><dd>{formatInrText(shipment.shipping_charged)}</dd></div>
          <div><dt>Courier cost</dt><dd>{formatInrText(shipment.courier_cost)}</dd></div>
          <div><dt>Difference</dt><dd className={shipment.shipping_margin.startsWith('-') ? 'bad-text' : ''}>{formatInrText(shipment.shipping_margin)}</dd></div>
        </dl>
        <p className="muted">The shipping charge is billed on <Link to={`/orders/${shipment.billed_order_id}`}>{shipment.billed_order}</Link>.</p>
      </div>

      <h2>In this parcel ({shipment.units} {shipment.units === 1 ? 'piece' : 'pieces'})</h2>
      <div className="card">
        <ul className="history">
          {shipment.lines.map((l) => (
            <li key={`${l.order_code}-${l.line_no}`}>
              <span className="qty">{l.quantity}</span>
              <span>
                <strong>{l.sku}</strong> &ndash; {l.product_name}, {l.fabric}, {l.size}, {l.colour}
                <span className="muted block"><Link to={`/orders/${l.order_id}`}>{l.order_code}</Link></span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      {dialog === 'delivered' && <DeliveredDialog shipment={shipment} onDone={done} onClose={() => setDialog(null)} />}
      {dialog === 'edit' && <EditDialog shipment={shipment} isOwner={user.role === 'owner'} onDone={done} onClose={() => setDialog(null)} />}
    </>
  );
}
