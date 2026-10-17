import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { formatInr, formatInrText, toPaise } from '../money.js';
import Modal from '../components/Modal.jsx';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const paiseText = (p) => `${p < 0 ? '-' : ''}${Math.floor(Math.abs(p) / 100)}.${String(Math.abs(p) % 100).padStart(2, '0')}`;

// Pop-up: record the one payment for a courier's month. Untick any parcel the courier has not billed yet.
function SettleDialog({ group, methods, today, onDone, onClose }) {
  const [parcels, setParcels] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [amount, setAmount] = useState('');
  const [touched, setTouched] = useState(false); // once you type an amount, stop overwriting it
  const [form, setForm] = useState({ paid_on: today, payment_method: '', note: '' });
  const [sure, setSure] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/courier/parcels?courier_id=${group.courier_id}&month=${group.month}`)
      .then((d) => {
        setParcels(d.parcels);
        setPicked(new Set(d.parcels.map((p) => p.id)));
      })
      .catch((err) => setError(err.message));
  }, [group.courier_id, group.month]);

  const totalPaise = (parcels ?? []).filter((p) => picked.has(p.id)).reduce((sum, p) => sum + (toPaise(p.courier_cost) ?? 0), 0);
  useEffect(() => {
    if (!touched) setAmount(paiseText(totalPaise));
  }, [totalPaise, touched]);

  const paidPaise = toPaise(amount);
  const differs = paidPaise !== null && paidPaise !== totalPaise;
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ready = picked.size > 0 && paidPaise !== null && paidPaise > 0 && form.payment_method && sure && (!differs || form.note.trim().length > 0);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api('/courier/settlements', {
        method: 'POST',
        body: { courier_id: group.courier_id, month: group.month, shipment_ids: [...picked], amount, paid_on: form.paid_on, payment_method: form.payment_method, note: form.note },
      });
      onDone(`Recorded ${res.settlement.code}: ${formatInrText(res.settlement.amount_paid)} paid to ${res.settlement.courier}${res.settlement.reconciliation === 'Check' ? ' (does not match the parcels: please review)' : ''}.`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`Pay ${group.courier}: ${monthLabel(group.month)}`} onClose={onClose}>
      <form onSubmit={submit}>
        {error && <div className="alert error" role="alert">{error}</div>}
        {!group.month_over && <div className="alert warn">This month is not over yet. Parcels sent later this month will stay unpaid for the next payment.</div>}
        {!parcels && !error && <div className="loading">Loading...</div>}
        {parcels && (
          <>
            <p className="muted">Tick the parcels this payment covers. Untick any the courier has not billed you for.</p>
            <ul className="history pick-list">
              {parcels.map((p) => (
                <li key={p.id}>
                  <label className="check">
                    <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
                    <span>
                      <strong>{p.code}</strong> &middot; {p.shipped_on} &middot; {p.units} {p.units === 1 ? 'piece' : 'pieces'}
                      <span className="muted block">{p.orders.map((o) => o.code).join(', ')} &middot; {p.customers}</span>
                    </span>
                  </label>
                  <span className="qty">{formatInrText(p.courier_cost)}</span>
                </li>
              ))}
            </ul>
            <p>Parcels ticked: <strong>{picked.size}</strong> &middot; their courier cost totals <strong>{formatInr(totalPaise)}</strong></p>

            <div className="field">
              <label htmlFor="cs-amount">Amount you paid the courier</label>
              <div className="money-input"><span>₹</span><input id="cs-amount" type="text" inputMode="decimal" value={amount} onChange={(e) => { setTouched(true); setAmount(e.target.value.trim()); }} /></div>
            </div>
            {differs && (
              <div className="alert warn">
                <strong>Does not match.</strong> You paid {formatInr(paidPaise)} but the parcels total {formatInr(totalPaise)} (a difference of {formatInr(paidPaise - totalPaise)}).
                Please explain why in the note, or fix a parcel's courier cost first.
              </div>
            )}
            <div className="form-grid">
              <div className="field">
                <label htmlFor="cs-date">Date paid</label>
                <input id="cs-date" type="date" value={form.paid_on} max={today} onChange={set('paid_on')} />
              </div>
              <div className="field">
                <label htmlFor="cs-method">Paid by</label>
                <select id="cs-method" value={form.payment_method} onChange={set('payment_method')}>
                  <option value="">Choose...</option>
                  {methods.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="cs-note">Note{differs ? ' (required: explain the difference)' : ' (optional)'}</label>
              <input id="cs-note" type="text" maxLength={300} value={form.note} onChange={set('note')} />
            </div>
            <label className="check sure">
              <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
              I have checked this. It can't be changed afterwards.
            </label>
          </>
        )}
        <div className="actions">
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={busy || !parcels || !ready}>
            {busy ? 'Saving...' : `Record ${paidPaise ? formatInr(paidPaise) : 'payment'} paid to ${group.courier}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SettlementRow({ s }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');

  async function toggle() {
    setOpen((o) => !o);
    if (!detail) {
      try {
        setDetail((await api(`/courier/settlements/${s.id}`)).settlement);
      } catch (err) {
        setError(err.message);
      }
    }
  }

  return (
    <div className="card variant-card">
      <div className="variant-card-head">
        <strong>{s.code}</strong>
        <span className={`badge ${s.reconciliation === 'Matches' ? 'good' : 'warn'}`}>{s.reconciliation === 'Matches' ? 'Matches' : 'Check'}</span>
      </div>
      <div>{s.courier} &middot; {monthLabel(s.month)} &middot; paid {s.paid_on}{s.payment_method && <> by {s.payment_method}</>}</div>
      <dl className="money-list">
        <div><dt>Paid</dt><dd>{formatInrText(s.amount_paid)}</dd></div>
        <div><dt>Parcels total</dt><dd>{formatInrText(s.shipments_total)}</dd></div>
        <div><dt>Difference</dt><dd className={Number(s.difference) !== 0 ? 'bad-text' : ''}>{formatInrText(s.difference)}</dd></div>
      </dl>
      {s.note && <div className="muted">{s.note}</div>}
      <button type="button" className="linkbtn top-gap-sm" onClick={toggle}>{open ? 'Hide' : 'Show'} the {s.parcels} {s.parcels === 1 ? 'parcel' : 'parcels'}</button>
      {open && (
        <ul className="history">
          {error && <li className="bad-text">{error}</li>}
          {!detail && !error && <li className="muted">Loading...</li>}
          {detail?.parcel_list.map((p) => (
            <li key={p.id}>
              <span className="qty">{formatInrText(p.courier_cost)}</span>
              <span><Link to={`/shipments/${p.id}`}><strong>{p.code}</strong></Link> <span className="muted block">{p.shipped_on} &middot; {p.orders.map((o) => o.code).join(', ')}</span></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function CourierMonthEnd() {
  const [payable, setPayable] = useState(null);
  const [settlements, setSettlements] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [settling, setSettling] = useState(null);

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([api('/courier/payable'), api('/courier/settlements')]);
      setPayable(p);
      setSettlements(s.settlements);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!flash) return undefined;
    const timer = setTimeout(() => setFlash(''), 8000);
    return () => clearTimeout(timer);
  }, [flash]);

  return (
    <>
      {flash && <div className="alert ok" role="status">{flash}</div>}
      {error && <div className="alert error" role="alert">{error}</div>}

      <h2 className="tab-h">Waiting to be paid</h2>
      {!payable && !error && <div className="loading">Loading...</div>}
      {payable && payable.groups.length === 0 && <div className="card empty"><p>Nothing is waiting: every parcel's courier cost has been paid.</p></div>}
      {payable && payable.groups.length > 0 && (
        <div className="cards">
          {payable.groups.map((g) => (
            <div className="card variant-card" key={`${g.courier_id}-${g.month}`}>
              <div className="variant-card-head"><strong>{g.courier}</strong><span>{monthLabel(g.month)}</span></div>
              <dl className="money-list">
                <div><dt>Parcels</dt><dd>{g.parcels}</dd></div>
                <div><dt>You owe</dt><dd>{formatInrText(g.amount_due)}</dd></div>
              </dl>
              {!g.month_over && <div className="muted">This month is not over yet.</div>}
              <div className="top-gap-sm"><button className="btn small" onClick={() => setSettling(g)}>Settle</button></div>
            </div>
          ))}
        </div>
      )}

      <h2 className="tab-h">Past payments</h2>
      {settlements && settlements.length === 0 && <p className="muted">No courier payments recorded yet.</p>}
      {settlements && settlements.length > 0 && <div className="cards">{settlements.map((s) => <SettlementRow key={s.id} s={s} />)}</div>}

      {settling && (
        <SettleDialog
          group={settling}
          methods={payable.methods}
          today={payable.today}
          onClose={() => setSettling(null)}
          onDone={async (message) => { setSettling(null); setFlash(message); await load(); }}
        />
      )}
    </>
  );
}
