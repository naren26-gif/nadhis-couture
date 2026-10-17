import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { formatInrText } from '../money.js';
import { OrderStatusBadge, PaymentBadge } from '../components/PurchaseBadges.jsx';

const NO_FILTERS = { search: '', customer: '', status: '', payment: '', waiting: false, credit: false };

export default function Orders() {
  const location = useLocation();
  const [lookups, setLookups] = useState(null);
  const [filters, setFilters] = useState(NO_FILTERS);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(location.state?.flash || '');

  const setFilter = (field) => (value) => setFilters((f) => ({ ...f, [field]: value }));

  useEffect(() => {
    api('/orders/lookups').then(setLookups).catch((err) => setError(err.message));
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value === true ? 'true' : value);
    try {
      setData(await api(`/orders?${params}`));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [filters]);

  useEffect(() => {
    const timer = setTimeout(load, filters.search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, filters.search]);

  useEffect(() => {
    if (!flash) return undefined;
    window.history.replaceState({}, '');
    const timer = setTimeout(() => setFlash(''), 6000);
    return () => clearTimeout(timer);
  }, [flash]);

  const hasFilters = Object.values(filters).some(Boolean);
  const list = data?.orders;
  const who = (o) => o.customer_name || 'Walk-in customer';

  return (
    <>
      <div className="page-head">
        <h1>Orders</h1>
        <Link className="btn" to="/orders/new">+ New order</Link>
      </div>

      {flash && <div className="alert ok" role="status">{flash}</div>}
      {error && <div className="alert error" role="alert">{error}</div>}

      {data && (
        <div className="tiles summary">
          <div className="tile"><strong>{data.totals.open_orders}</strong>orders still to ship</div>
          <div className="tile"><strong>{formatInrText(data.totals.to_collect)}</strong>still to collect from customers</div>
          <div className="tile"><strong>{data.totals.waiting_for_stock}</strong>orders waiting for stock</div>
          {Number(data.totals.credit_held) > 0 && (
            <div className="tile"><strong>{formatInrText(data.totals.credit_held)}</strong>credit held for customers ({data.totals.credit_orders} {data.totals.credit_orders === 1 ? 'order' : 'orders'})</div>
          )}
        </div>
      )}

      <div className="card filters">
        <div className="field grow">
          <label htmlFor="search">Search</label>
          <input id="search" type="search" placeholder="Order code, customer name or phone, notes" value={filters.search} onChange={(e) => setFilter('search')(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="f-customer">Customer</label>
          <select id="f-customer" value={filters.customer} onChange={(e) => setFilter('customer')(e.target.value)}>
            <option value="">All</option>
            {lookups?.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-status">Status</label>
          <select id="f-status" value={filters.status} onChange={(e) => setFilter('status')(e.target.value)}>
            <option value="">All</option>
            {['Pending', 'Partially Shipped', 'Shipped', 'Delivered'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-payment">Payment</label>
          <select id="f-payment" value={filters.payment} onChange={(e) => setFilter('payment')(e.target.value)}>
            <option value="">All</option>
            {['Unpaid', 'Partial', 'Paid', 'Advance'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="filter-foot">
          <label className="check">
            <input type="checkbox" checked={filters.waiting} onChange={(e) => setFilter('waiting')(e.target.checked)} />
            Only orders waiting for stock
          </label>
          <label className="check">
            <input type="checkbox" checked={filters.credit} onChange={(e) => setFilter('credit')(e.target.checked)} />
            Only orders holding customer credit
          </label>
          {hasFilters && <button type="button" className="linkbtn" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
        </div>
      </div>

      {!data && !error && <div className="loading">Loading...</div>}

      {list && (
        <>
          <p className="muted count">{list.length} {list.length === 1 ? 'order' : 'orders'}</p>
          {list.length === 0 && (
            <div className="card empty">
              <p>No orders match.</p>
              {hasFilters ? <button className="btn secondary" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button> : <Link className="btn" to="/orders/new">Create your first order</Link>}
            </div>
          )}

          {list.length > 0 && (
            <>
              <div className="only-wide card table-card">
                <table>
                  <thead>
                    <tr><th>Order</th><th>Date</th><th>Customer</th><th className="num">Shipped</th><th className="num">Total</th><th className="num">Balance</th><th>Payment</th><th>Status</th><th /></tr>
                  </thead>
                  <tbody>
                    {list.map((o) => (
                      <tr key={o.id}>
                        <td><Link to={`/orders/${o.id}`}><strong>{o.code}</strong></Link></td>
                        <td>{o.order_date}</td>
                        <td>{who(o)}</td>
                        <td className="num">{o.shipped_qty} / {o.ordered_qty}</td>
                        <td className="num">{formatInrText(o.order_total)}</td>
                        <td className="num">{formatInrText(o.balance)}</td>
                        <td><PaymentBadge state={o.payment_state} /></td>
                        <td>
                          <div className="badge-row">
                            <OrderStatusBadge status={o.status} />
                            {o.waiting_for_stock && <span className="badge bad">Waiting for stock</span>}
                          </div>
                        </td>
                        <td><div className="row-actions"><Link className="btn secondary small" to={`/orders/${o.id}`}>Open</Link></div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="only-narrow cards">
                {list.map((o) => (
                  <Link key={o.id} to={`/orders/${o.id}`} className="card variant-card card-link">
                    <div className="variant-card-head">
                      <strong>{o.code}</strong>
                      <span className="muted">{o.order_date}</span>
                    </div>
                    <div>{who(o)}</div>
                    <div className="muted">{o.shipped_qty} of {o.ordered_qty} pieces shipped</div>
                    <dl className="money-list">
                      <div><dt>Total</dt><dd>{formatInrText(o.order_total)}</dd></div>
                      <div><dt>Received</dt><dd>{formatInrText(o.received)}</dd></div>
                      <div><dt>Balance</dt><dd>{formatInrText(o.balance)}</dd></div>
                    </dl>
                    <div className="badge-row">
                      <PaymentBadge state={o.payment_state} />
                      <OrderStatusBadge status={o.status} />
                      {o.waiting_for_stock && <span className="badge bad">Waiting for stock</span>}
                    </div>
                  </Link>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
