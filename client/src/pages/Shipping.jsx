import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { formatInrText } from '../money.js';
import { ShipmentStatusBadge } from '../components/PurchaseBadges.jsx';
import CourierMonthEnd from './CourierMonthEnd.jsx';

const TABS = [
  ['ready', 'Ready to ship'],
  ['buy', 'What to buy'],
  ['parcels', 'Parcels'],
  ['courier', 'Courier payments'],
];

function ReadyTab() {
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api('/shipments/ready').then((d) => setOrders(d.orders)).catch((err) => setError(err.message));
  }, []);
  if (error) return <div className="alert error" role="alert">{error}</div>;
  if (!orders) return <div className="loading">Loading...</div>;
  if (orders.length === 0) return <div className="card empty"><p>Nothing can be shipped right now.</p><p className="muted">Orders appear here as soon as stock for them is available.</p></div>;
  return (
    <div className="cards">
      {orders.map((o) => (
        <div className="card variant-card" key={o.id}>
          <div className="variant-card-head">
            <Link to={`/orders/${o.id}`}><strong>{o.code}</strong></Link>
            <span className="muted">{o.order_date}</span>
          </div>
          <div>{o.customer_name}</div>
          <div className="badge-row top-gap-sm">
            {o.short_units === 0 ? <span className="badge good">Everything is in stock</span> : <span className="badge warn">{o.ready_units} of {o.remaining_units} can go now</span>}
            <span className="badge muted-badge">{o.status}</span>
          </div>
          <div className="top-gap-sm"><Link className="btn small" to={`/orders/${o.id}?ship=1`}>Open and ship</Link></div>
        </div>
      ))}
    </div>
  );
}

function BuyTab() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api('/shipments/to-buy').then((d) => setItems(d.items)).catch((err) => setError(err.message));
  }, []);
  if (error) return <div className="alert error" role="alert">{error}</div>;
  if (!items) return <div className="loading">Loading...</div>;
  if (items.length === 0) return <div className="card empty"><p>Nothing to buy: stock covers every waiting order.</p></div>;
  return (
    <>
      <p className="muted">Customers are waiting for these pieces and stock can't cover them yet.</p>
      <div className="card table-card">
        <table>
          <thead><tr><th>SKU</th><th>Product</th><th className="num">Waiting</th><th className="num">In stock</th><th className="num">To buy</th></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.sku}>
                <td><strong>{i.sku}</strong></td>
                <td>{i.product}</td>
                <td className="num">{i.units_waiting}</td>
                <td className="num">{i.on_hand}</td>
                <td className="num"><strong>{i.units_to_buy}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p><Link className="btn" to="/purchases/new">+ New purchase</Link></p>
    </>
  );
}

function ParcelsTab() {
  const [filters, setFilters] = useState({ search: '', status: '', courier_payment: '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const setFilter = (field) => (value) => setFilters((f) => ({ ...f, [field]: value }));

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    try {
      setData(await api(`/shipments?${params}`));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [filters]);

  useEffect(() => {
    const timer = setTimeout(load, filters.search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, filters.search]);

  const hasFilters = Object.values(filters).some(Boolean);
  const list = data?.shipments;

  return (
    <>
      {error && <div className="alert error" role="alert">{error}</div>}
      {data && (
        <div className="tiles summary">
          <div className="tile"><strong>{data.totals.on_the_way}</strong>parcels not yet delivered</div>
          <div className="tile"><strong>{formatInrText(data.totals.courier_unpaid)}</strong>courier cost not yet paid</div>
        </div>
      )}
      <div className="card filters">
        <div className="field grow">
          <label htmlFor="search">Search</label>
          <input id="search" type="search" placeholder="Parcel code, tracking number, order or customer" value={filters.search} onChange={(e) => setFilter('search')(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="f-status">Status</label>
          <select id="f-status" value={filters.status} onChange={(e) => setFilter('status')(e.target.value)}>
            <option value="">All</option>
            {['Shipped', 'In Transit', 'Delivered'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-courier">Courier paid?</label>
          <select id="f-courier" value={filters.courier_payment} onChange={(e) => setFilter('courier_payment')(e.target.value)}>
            <option value="">All</option>
            <option value="Unpaid">Not paid yet</option>
            <option value="Paid">Paid</option>
          </select>
        </div>
        {hasFilters && (
          <div className="filter-foot"><span /><button type="button" className="linkbtn" onClick={() => setFilters({ search: '', status: '', courier_payment: '' })}>Clear filters</button></div>
        )}
      </div>

      {!data && !error && <div className="loading">Loading...</div>}
      {list && list.length === 0 && <div className="card empty"><p>No parcels match.</p></div>}
      {list && list.length > 0 && (
        <>
          <p className="muted count">{list.length} {list.length === 1 ? 'parcel' : 'parcels'}</p>
          <div className="only-wide card table-card">
            <table>
              <thead><tr><th>Parcel</th><th>Shipped</th><th>Orders</th><th>Customer</th><th className="num">Pieces</th><th className="num">Charged</th><th className="num">Courier</th><th>Status</th><th>Courier paid</th></tr></thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id}>
                    <td><Link to={`/shipments/${s.id}`}><strong>{s.code}</strong></Link></td>
                    <td>{s.shipped_on}</td>
                    <td>{s.orders.map((o) => o.code).join(', ')}</td>
                    <td>{s.customers}</td>
                    <td className="num">{s.units}</td>
                    <td className="num">{formatInrText(s.shipping_charged)}</td>
                    <td className="num">{formatInrText(s.courier_cost)}</td>
                    <td><ShipmentStatusBadge status={s.status} /></td>
                    <td>{s.paid_to_courier ? <span className="badge good">Paid</span> : <span className="badge muted-badge">Not yet</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="only-narrow cards">
            {list.map((s) => (
              <Link key={s.id} to={`/shipments/${s.id}`} className="card variant-card card-link">
                <div className="variant-card-head"><strong>{s.code}</strong><span className="muted">{s.shipped_on}</span></div>
                <div>{s.customers}</div>
                <div className="muted">{s.orders.map((o) => o.code).join(', ')} &middot; {s.units} {s.units === 1 ? 'piece' : 'pieces'}</div>
                <dl className="money-list">
                  <div><dt>Charged</dt><dd>{formatInrText(s.shipping_charged)}</dd></div>
                  <div><dt>Courier</dt><dd>{formatInrText(s.courier_cost)}</dd></div>
                </dl>
                <div className="badge-row"><ShipmentStatusBadge status={s.status} />{s.paid_to_courier && <span className="badge good">Courier paid</span>}</div>
              </Link>
            ))}
          </div>
        </>
      )}
    </>
  );
}

export default function Shipping() {
  // the tab lives in the address (?tab=courier) so the Home tile and links can open a specific tab
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab = TABS.some(([key]) => key === asked) ? asked : 'ready';
  const setTab = (key) => setParams(key === 'ready' ? {} : { tab: key }, { replace: true });
  return (
    <>
      <div className="page-head"><h1>Shipping</h1></div>
      <div className="seg tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === 'ready' && <ReadyTab />}
      {tab === 'buy' && <BuyTab />}
      {tab === 'parcels' && <ParcelsTab />}
      {tab === 'courier' && <CourierMonthEnd />}
    </>
  );
}
