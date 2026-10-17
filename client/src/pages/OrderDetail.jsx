import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { formatInrText, toPaise } from '../money.js';
import Modal from '../components/Modal.jsx';
import ShipDialog from '../components/ShipDialog.jsx';
import { OrderStatusBadge, PaymentBadge } from '../components/PurchaseBadges.jsx';

const todayInIndia = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

// Pop-up: record money received from the customer. More than the balance needs a confirmation (there are no refunds).
function PaymentDialog({ order, methods, onDone, onClose }) {
  const balancePaise = Math.max(toPaise(order.balance) ?? 0, 0);
  const [form, setForm] = useState({ amount: balancePaise > 0 ? order.balance : '', txn_date: todayInIndia(), payment_method: '', note: '' });
  const [advance, setAdvance] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const paise = toPaise(form.amount);
  const isMore = paise !== null && paise > balancePaise;

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api(`/orders/${order.id}/payments`, { method: 'POST', body: { ...form, confirm_advance: isMore && advance } });
      onDone(`Payment of ${formatInrText(form.amount)} recorded.`, res.order);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Record a payment" onClose={onClose}>
      <form onSubmit={submit}>
        {error && <div className="alert error" role="alert">{error}</div>}
        <p className="muted">Balance to collect now: <strong>{formatInrText(order.balance)}</strong></p>
        <div className="field">
          <label htmlFor="pay-amount">Amount received</label>
          <div className="money-input"><span>₹</span><input id="pay-amount" type="text" inputMode="decimal" value={form.amount} onChange={set('amount')} autoFocus /></div>
        </div>
        {isMore && (
          <div className="alert warn">
            <label className="check">
              <input type="checkbox" checked={advance} onChange={(e) => setAdvance(e.target.checked)} />
              This is more than the balance. The customer is paying in advance (for example for shipping still to be added). Payments can't be refunded or removed.
            </label>
          </div>
        )}
        <div className="field">
          <label htmlFor="pay-date">Date received</label>
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
          <button type="submit" className="btn" disabled={busy || !form.payment_method || (isMore && !advance)}>{busy ? 'Saving...' : 'Save payment'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Pop-up: pay back money the customer paid beyond what the order is worth. Not a cancellation: only the surplus can go back.
function RefundDialog({ order, methods, onDone, onClose }) {
  const [form, setForm] = useState({ amount: order.credit_held, txn_date: todayInIndia(), payment_method: '', reason: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api(`/orders/${order.id}/refunds`, { method: 'POST', body: form });
      onDone(`Refund of ${formatInrText(form.amount)} recorded.`, res.order);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Refund the customer" onClose={onClose}>
      <form onSubmit={submit}>
        {error && <div className="alert error" role="alert">{error}</div>}
        <p className="muted">
          The customer has paid <strong>{formatInrText(order.credit_held)}</strong> more than this order is worth. You can pay back up to that amount.
          Refunds can't be edited or removed afterwards.
        </p>
        <div className="field">
          <label htmlFor="rf-amount">Amount paid back</label>
          <div className="money-input"><span>₹</span><input id="rf-amount" type="text" inputMode="decimal" value={form.amount} onChange={set('amount')} autoFocus /></div>
        </div>
        <div className="field">
          <label htmlFor="rf-date">Date paid back</label>
          <input id="rf-date" type="date" value={form.txn_date} max={todayInIndia()} onChange={set('txn_date')} />
        </div>
        <div className="field">
          <label htmlFor="rf-method">Paid back by</label>
          <select id="rf-method" value={form.payment_method} onChange={set('payment_method')}>
            <option value="">Choose...</option>
            {methods.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rf-reason">Reason (required)</label>
          <input id="rf-reason" type="text" maxLength={300} value={form.reason} onChange={set('reason')} placeholder="For example: only one piece was available" />
        </div>
        <div className="actions">
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={busy || !form.payment_method || form.reason.trim().length < 3}>{busy ? 'Saving...' : 'Record refund'}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function OrderDetail() {
  const { id } = useParams();
  const location = useLocation();
  const [order, setOrder] = useState(null);
  const [methods, setMethods] = useState([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(location.state?.flash || '');
  const [paying, setPaying] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [shipping, setShipping] = useState(location.search.includes('ship=1')); // the Shipping page links here to start a parcel

  const load = useCallback(async () => {
    try {
      const [o, lk] = await Promise.all([api(`/orders/${id}`), api('/orders/lookups')]);
      setOrder(o.order);
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

  if (error) return <><p><Link to="/orders">&larr; Back to orders</Link></p><div className="alert error" role="alert">{error}</div></>;
  if (!order) return <div className="loading">Loading...</div>;

  const canShip = order.editable && order.lines.some((l) => l.remaining > 0);
  const hasCredit = Number(order.credit_held) > 0;
  const hasRefunds = Number(order.refunded) > 0;
  const who = order.customer_name ? `${order.customer_name}${order.customer_phone ? ` · ${order.customer_phone}` : ''}` : 'Walk-in customer';

  return (
    <>
      <p><Link to="/orders">&larr; Back to orders</Link></p>
      <div className="page-head">
        <h1>{order.code}</h1>
        <div className="row-actions">
          {canShip && <button className="btn" onClick={() => setShipping(true)}>Ship</button>}
          <button className="btn" onClick={() => setPaying(true)}>Record payment</button>
          {hasCredit && <button className="btn secondary" onClick={() => setRefunding(true)}>Refund customer</button>}
          {order.editable && <Link className="btn secondary" to={`/orders/${order.id}/edit`}>Edit</Link>}
        </div>
      </div>

      {flash && <div className="alert ok" role="status">{flash}</div>}

      <div className="card">
        <div><strong>{who}</strong> &middot; {order.order_date}</div>
        {order.notes && <div className="muted">{order.notes}</div>}
        <div className="badge-row top-gap-sm">
          <OrderStatusBadge status={order.status} />
          <PaymentBadge state={order.payment_state} />
          {order.waiting_for_stock && <span className="badge bad">Waiting for stock</span>}
        </div>
        <dl className="money-list">
          <div><dt>Products</dt><dd>{formatInrText(order.items_total)}</dd></div>
          <div><dt>Shipping so far</dt><dd>{formatInrText(order.shipping_charged)}</dd></div>
          <div><dt>Order total</dt><dd>{formatInrText(order.order_total)}</dd></div>
          <div><dt>{hasRefunds ? 'Received (after refunds)' : 'Received'}</dt><dd>{formatInrText(order.received)}</dd></div>
          <div><dt>Balance</dt><dd>{formatInrText(order.balance)}</dd></div>
          {hasRefunds && <div><dt>Refunded</dt><dd>{formatInrText(order.refunded)}</dd></div>}
          <div><dt>Profit on products</dt><dd className={order.profit.startsWith('-') ? 'bad-text' : ''}>{formatInrText(order.profit)}</dd></div>
        </dl>
        {hasCredit && (
          <div className="alert warn top-gap-sm">
            Credit held for the customer: <strong>{formatInrText(order.credit_held)}</strong> (paid more than the order is worth).
            Shipping charges added later will use it up, or you can pay it back with "Refund customer".
          </div>
        )}
        {order.payment_state === 'Advance' && !hasCredit && <p className="muted">Money was received in advance. Shipping charges are added as parcels are sent.</p>}
        {!order.editable && <p className="muted">This order has shipped, so its products can't be edited. Payments can still be recorded.</p>}
      </div>

      <h2>Products</h2>
      <div className="only-wide card table-card">
        <table>
          <thead><tr><th>SKU</th><th>Product</th><th className="num">Price</th><th className="num">Discount</th><th className="num">Ordered</th><th className="num">Shipped</th><th className="num">In stock</th><th className="num">Line total</th></tr></thead>
          <tbody>
            {order.lines.map((l) => (
              <tr key={l.item_id}>
                <td><strong>{l.sku}</strong></td>
                <td>{l.product_name}, {l.fabric}, {l.size}, {l.colour}</td>
                <td className="num">{formatInrText(l.unit_price)}</td>
                <td className="num">{formatInrText(l.discount)}</td>
                <td className="num">{l.quantity}</td>
                <td className="num">{l.shipped}{l.remaining > 0 && l.remaining > l.on_hand && <span className="bad-text"> (short)</span>}</td>
                <td className="num">{l.on_hand}</td>
                <td className="num">{formatInrText(l.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="only-narrow cards">
        {order.lines.map((l) => (
          <div className="card variant-card" key={l.item_id}>
            <div className="variant-card-head"><strong>{l.sku}</strong><span>{formatInrText(l.line_total)}</span></div>
            <div className="muted">{l.product_name}, {l.fabric}, {l.size}, {l.colour}</div>
            <dl className="money-list">
              <div><dt>Ordered</dt><dd>{l.quantity}</dd></div>
              <div><dt>Shipped</dt><dd>{l.shipped}</dd></div>
              <div><dt>In stock</dt><dd className={l.remaining > l.on_hand ? 'bad-text' : ''}>{l.on_hand}</dd></div>
            </dl>
            <div className="muted">{formatInrText(l.unit_price)} each{Number(l.discount) > 0 && <>, {formatInrText(l.discount)} off</>}</div>
          </div>
        ))}
      </div>

      {order.parcels.length > 0 && (
        <>
          <h2>Parcels</h2>
          <div className="card">
            <ul className="history">
              {order.parcels.map((p) => (
                <li key={p.code}>
                  <span className="qty">{p.units_here}</span>
                  <span>
                    <Link to={`/shipments/${p.id}`}><strong>{p.code}</strong></Link> &ndash; {p.status}
                    <span className="muted block">
                      Shipped {p.shipped_on}{p.tracking_number && <> &middot; tracking {p.tracking_number}</>}
                      {p.billed_here && Number(p.shipping_charged) > 0 && <> &middot; shipping charged {formatInrText(p.shipping_charged)}</>}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <h2>Payments</h2>
      {order.payments.length === 0 ? (
        <p className="muted">No payments received yet.</p>
      ) : (
        <div className="card">
          <ul className="history">
            {order.payments.map((p) => (
              <li key={p.transaction_id}>
                <span className={`qty ${p.direction === 'Out' ? 'bad-text' : ''}`}>{p.direction === 'Out' ? '-' : ''}{formatInrText(p.amount)}</span>
                <span>
                  <strong>{p.direction === 'Out' ? 'Refund' : (p.payment_method || 'Method not recorded')}</strong>
                  {p.direction === 'Out' && <> by {p.payment_method || 'method not recorded'}</>}
                  {p.payment_status !== 'Completed' && <> &ndash; {p.payment_status}</>}
                  <span className="muted block">{p.txn_date} &middot; {p.code}{p.note && <> &middot; {p.direction === 'Out' ? `Reason: ${p.note}` : p.note}</>}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {shipping && (
        <ShipDialog
          order={order}
          onClose={() => setShipping(false)}
          onDone={async (message) => { setShipping(false); setFlash(message); await load(); }}
        />
      )}
      {refunding && (
        <RefundDialog
          order={order}
          methods={methods}
          onClose={() => setRefunding(false)}
          onDone={(message, updated) => { setRefunding(false); setFlash(message); setOrder(updated); }}
        />
      )}
      {paying && (
        <PaymentDialog
          order={order}
          methods={methods}
          onClose={() => setPaying(false)}
          onDone={(message, updated) => { setPaying(false); setFlash(message); setOrder(updated); }}
        />
      )}
    </>
  );
}
