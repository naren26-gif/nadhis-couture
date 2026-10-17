import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { formatInrText } from '../money.js';
import { PaymentBadge, ReceiptBadge } from '../components/PurchaseBadges.jsx';

const NO_FILTERS = { search: '', supplier: '', type: '', payment: '', receipt: '' };

export default function Purchases() {
  const location = useLocation();
  const [lookups, setLookups] = useState(null);
  const [filters, setFilters] = useState(NO_FILTERS);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(location.state?.flash || '');

  const setFilter = (field) => (value) => setFilters((f) => ({ ...f, [field]: value }));

  useEffect(() => {
    api('/purchases/lookups').then(setLookups).catch((err) => setError(err.message));
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    try {
      setData(await api(`/purchases?${params}`));
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
  const list = data?.purchases;

  return (
    <>
      <div className="page-head">
        <h1>Purchases</h1>
        <Link className="btn" to="/purchases/new">+ New purchase</Link>
      </div>

      {flash && <div className="alert ok" role="status">{flash}</div>}
      {error && <div className="alert error" role="alert">{error}</div>}

      {data && (
        <div className="tiles summary">
          <div className="tile"><strong>{formatInrText(data.totals.owed)}</strong>owed to suppliers</div>
          <div className="tile"><strong>{data.totals.unpaid_count}</strong>purchases not fully paid</div>
          <div className="tile"><strong>{data.totals.awaiting_receipt}</strong>waiting for stock to arrive</div>
        </div>
      )}

      <div className="card filters">
        <div className="field grow">
          <label htmlFor="search">Search</label>
          <input id="search" type="search" placeholder="PO code, supplier or notes" value={filters.search} onChange={(e) => setFilter('search')(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="f-supplier">Supplier</label>
          <select id="f-supplier" value={filters.supplier} onChange={(e) => setFilter('supplier')(e.target.value)}>
            <option value="">All</option>
            {lookups?.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-type">Type</label>
          <select id="f-type" value={filters.type} onChange={(e) => setFilter('type')(e.target.value)}>
            <option value="">All</option>
            {lookups?.types.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-payment">Payment</label>
          <select id="f-payment" value={filters.payment} onChange={(e) => setFilter('payment')(e.target.value)}>
            <option value="">All</option>
            {['Unpaid', 'Partial', 'Paid'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-receipt">Stock</label>
          <select id="f-receipt" value={filters.receipt} onChange={(e) => setFilter('receipt')(e.target.value)}>
            <option value="">All</option>
            {['Not received', 'Partly received', 'Received', 'No stock'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        {hasFilters && (
          <div className="filter-foot">
            <span />
            <button type="button" className="linkbtn" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>
          </div>
        )}
      </div>

      {!data && !error && <div className="loading">Loading...</div>}

      {list && (
        <>
          <p className="muted count">{list.length} {list.length === 1 ? 'purchase' : 'purchases'}</p>
          {list.length === 0 && (
            <div className="card empty">
              <p>No purchases match.</p>
              {hasFilters ? <button className="btn secondary" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button> : <Link className="btn" to="/purchases/new">Record your first purchase</Link>}
            </div>
          )}

          {list.length > 0 && (
            <>
              <div className="only-wide card table-card">
                <table>
                  <thead>
                    <tr><th>PO</th><th>Date</th><th>Supplier</th><th>Type</th><th className="num">Total</th><th className="num">Balance</th><th>Payment</th><th>Stock</th><th /></tr>
                  </thead>
                  <tbody>
                    {list.map((p) => (
                      <tr key={p.id}>
                        <td><Link to={`/purchases/${p.id}`}><strong>{p.code}</strong></Link></td>
                        <td>{p.order_date}</td>
                        <td>{p.supplier_name}</td>
                        <td>{p.purchase_type}</td>
                        <td className="num">{formatInrText(p.total_amount)}</td>
                        <td className="num">{formatInrText(p.balance)}</td>
                        <td><PaymentBadge state={p.payment_state} /></td>
                        <td><ReceiptBadge state={p.receipt_status} /></td>
                        <td><div className="row-actions"><Link className="btn secondary small" to={`/purchases/${p.id}`}>Open</Link></div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="only-narrow cards">
                {list.map((p) => (
                  <Link key={p.id} to={`/purchases/${p.id}`} className="card variant-card card-link">
                    <div className="variant-card-head">
                      <strong>{p.code}</strong>
                      <span className="muted">{p.order_date}</span>
                    </div>
                    <div>{p.supplier_name}</div>
                    <div className="muted">{p.purchase_type}</div>
                    <dl className="money-list">
                      <div><dt>Total</dt><dd>{formatInrText(p.total_amount)}</dd></div>
                      <div><dt>Balance</dt><dd>{formatInrText(p.balance)}</dd></div>
                    </dl>
                    <div className="badge-row"><PaymentBadge state={p.payment_state} /><ReceiptBadge state={p.receipt_status} /></div>
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
