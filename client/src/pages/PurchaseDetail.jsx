import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { formatInrText } from '../money.js';
import Modal from '../components/Modal.jsx';
import { PaymentBadge, ReceiptBadge } from '../components/PurchaseBadges.jsx';

const todayInIndia = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

// Pop-up: how many pieces of each line arrived now? Defaults to everything still to come.
function ReceiveDialog({ purchase, onDone, onClose }) {
  const open = purchase.lines.filter((l) => l.remaining > 0);
  const [qty, setQty] = useState(() => Object.fromEntries(open.map((l) => [l.item_id, String(l.remaining)])));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const lines = open
    .map((l) => ({ item_id: l.item_id, quantity: /^\d+$/.test(qty[l.item_id]) ? Number(qty[l.item_id]) : 0 }))
    .filter((l) => l.quantity > 0);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api(`/purchases/${purchase.id}/receive`, { method: 'POST', body: { lines } });
      onDone(`Received ${res.received_pieces} ${res.received_pieces === 1 ? 'piece' : 'pieces'}. Stock updated.`, res.purchase);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Receive stock" onClose={onClose}>
      <form onSubmit={submit}>
        {error && <div className="alert error" role="alert">{error}</div>}
        <p className="muted">Enter how many pieces arrived. Leave 0 for anything that has not come yet.</p>
        {open.map((l) => (
          <div className="field" key={l.item_id}>
            <label htmlFor={`r-${l.item_id}`}>{l.sku} <span className="muted">({l.remaining} still to come)</span></label>
            <input id={`r-${l.item_id}`} type="text" inputMode="numeric" value={qty[l.item_id]} onChange={(e) => setQty((q) => ({ ...q, [l.item_id]: e.target.value.trim() }))} />
          </div>
        ))}
        <div className="actions">
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={busy || lines.length === 0}>{busy ? 'Saving...' : 'Add to stock'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Pop-up: record a payment to the supplier.
function PaymentDialog({ purchase, methods, onDone, onClose }) {
  const [form, setForm] = useState({ amount: purchase.balance, txn_date: todayInIndia(), payment_method: '', note: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api(`/purchases/${purchase.id}/payments`, { method: 'POST', body: form });
      onDone(`Payment of ${formatInrText(form.amount)} recorded.`, res.purchase);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Record a payment" onClose={onClose}>
      <form onSubmit={submit}>
        {error && <div className="alert error" role="alert">{error}</div>}
        <p className="muted">Balance to pay: <strong>{formatInrText(purchase.balance)}</strong></p>
        <div className="field">
          <label htmlFor="pay-amount">Amount paid</label>
          <div className="money-input"><span>₹</span><input id="pay-amount" type="text" inputMode="decimal" value={form.amount} onChange={set('amount')} autoFocus /></div>
        </div>
        <div className="field">
          <label htmlFor="pay-date">Date paid</label>
          <input id="pay-date" type="date" value={form.txn_date} max={todayInIndia()} onChange={set('txn_date')} />
        </div>
        <div className="field">
          <label htmlFor="pay-method">Paid by</label>
          <select id="pay-method" value={form.payment_method} onChange={set('payment_method')}>
            <option value="">Choose...</option>
            {methods.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pay-note">Note (optional)</label>
          <input id="pay-note" type="text" maxLength={300} value={form.note} onChange={set('note')} />
        </div>
        <div className="actions">
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={busy || !form.payment_method}>{busy ? 'Saving...' : 'Save payment'}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function PurchaseDetail() {
  const { id } = useParams();
  const location = useLocation();
  const [purchase, setPurchase] = useState(null);
  const [methods, setMethods] = useState([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(location.state?.flash || '');
  const [dialog, setDialog] = useState(null); // 'receive' | 'pay'

  const load = useCallback(async () => {
    try {
      const [p, lk] = await Promise.all([api(`/purchases/${id}`), api('/purchases/lookups')]);
      setPurchase(p.purchase);
      setMethods(lk.methods);
    } catch (err) {
      setError(err.message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!flash) return undefined;
    window.history.replaceState({}, '');
    const timer = setTimeout(() => setFlash(''), 6000);
    return () => clearTimeout(timer);
  }, [flash]);

  const done = (message, updated) => {
    setDialog(null);
    setFlash(message);
    setPurchase(updated);
  };

  if (error) return <><p><Link to="/purchases">&larr; Back to purchases</Link></p><div className="alert error" role="alert">{error}</div></>;
  if (!purchase) return <div className="loading">Loading...</div>;

  const canReceive = purchase.affects_stock && purchase.lines.some((l) => l.remaining > 0);
  const canPay = Number(purchase.balance) > 0;

  return (
    <>
      <p><Link to="/purchases">&larr; Back to purchases</Link></p>
      <div className="page-head">
        <h1>{purchase.code}</h1>
        <div className="row-actions">
          {canReceive && <button className="btn" onClick={() => setDialog('receive')}>Receive stock</button>}
          {canPay && <button className="btn" onClick={() => setDialog('pay')}>Record payment</button>}
          <Link className="btn secondary" to={`/purchases/${purchase.id}/edit`}>Edit</Link>
        </div>
      </div>

      {flash && <div className="alert ok" role="status">{flash}</div>}

      <div className="card">
        <div><strong>{purchase.supplier_name}</strong> &middot; {purchase.purchase_type} &middot; {purchase.order_date}</div>
        {purchase.notes && <div className="muted">{purchase.notes}</div>}
        <div className="badge-row top-gap-sm"><PaymentBadge state={purchase.payment_state} /><ReceiptBadge state={purchase.receipt_status} /></div>
        <dl className="money-list">
          <div><dt>Total</dt><dd>{formatInrText(purchase.total_amount)}</dd></div>
          <div><dt>Paid</dt><dd>{formatInrText(purchase.paid)}</dd></div>
          <div><dt>Balance</dt><dd>{formatInrText(purchase.balance)}</dd></div>
        </dl>
      </div>

      {purchase.lines.length > 0 && (
        <>
          <h2>Products</h2>
          <div className="only-wide card table-card">
            <table>
              <thead><tr><th>SKU</th><th>Product</th><th className="num">Cost</th><th className="num">Ordered</th><th className="num">Received</th><th className="num">Line total</th></tr></thead>
              <tbody>
                {purchase.lines.map((l) => (
                  <tr key={l.item_id}>
                    <td><strong>{l.sku}</strong></td>
                    <td>{l.product_name}, {l.fabric}, {l.size}, {l.colour}</td>
                    <td className="num">{formatInrText(l.unit_cost)}</td>
                    <td className="num">{l.qty_ordered}</td>
                    <td className="num">{l.qty_received}{l.remaining > 0 && <span className="muted"> ({l.remaining} to come)</span>}</td>
                    <td className="num">{formatInrText(l.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="only-narrow cards">
            {purchase.lines.map((l) => (
              <div className="card variant-card" key={l.item_id}>
                <div className="variant-card-head"><strong>{l.sku}</strong><span>{formatInrText(l.line_total)}</span></div>
                <div className="muted">{l.product_name}, {l.fabric}, {l.size}, {l.colour}</div>
                <dl className="money-list">
                  <div><dt>Cost</dt><dd>{formatInrText(l.unit_cost)}</dd></div>
                  <div><dt>Ordered</dt><dd>{l.qty_ordered}</dd></div>
                  <div><dt>Received</dt><dd>{l.qty_received}</dd></div>
                </dl>
              </div>
            ))}
          </div>
        </>
      )}

      <h2>Payments</h2>
      {purchase.payments.length === 0 ? (
        <p className="muted">No payments recorded yet.</p>
      ) : (
        <div className="card">
          <ul className="history">
            {purchase.payments.map((p) => (
              <li key={p.transaction_id}>
                <span className="qty">{formatInrText(p.amount)}</span>
                <span>
                  <strong>{p.payment_method || 'Method not recorded'}</strong>
                  {p.payment_status !== 'Completed' && <> &ndash; {p.payment_status}</>}
                  <span className="muted block">{p.txn_date} &middot; {p.code}{p.note && <> &middot; {p.note}</>}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {dialog === 'receive' && <ReceiveDialog purchase={purchase} onDone={done} onClose={() => setDialog(null)} />}
      {dialog === 'pay' && <PaymentDialog purchase={purchase} methods={methods} onDone={done} onClose={() => setDialog(null)} />}
    </>
  );
}
