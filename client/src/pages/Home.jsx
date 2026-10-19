import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { formatInr, formatInrText, toPaise } from '../money.js';
import { defaultCustom, periodOf, periodQuery } from '../periods.js';
import CompareBars from '../components/CompareBars.jsx';
import PeriodPicker from '../components/PeriodPicker.jsx';
import Sparkline from '../components/Sparkline.jsx';

// Series colours: the same validated blue and orange the Reports charts use.
const BLUE = '#2a78d6';
const ORANGE = '#eb6834';

const signed = (text) => (Number(text) > 0 ? `+${formatInrText(text)}` : formatInrText(text));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function Home() {
  const { user } = useAuth();
  const [preset, setPreset] = useState('last_6');
  const [custom, setCustom] = useState(defaultCustom);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const [toShip, setToShip] = useState(null); // orders still waiting to be shipped (null until loaded)

  const period = useMemo(() => periodOf(preset, custom), [preset, custom]);

  useEffect(() => {
    let cancelled = false;
    const q = periodQuery(period);
    setLoading(true);
    Promise.all([api(`/reports/overview?${q}`), api(`/reports/monthly?${q}`)])
      .then(([overview, monthly]) => {
        if (cancelled) return;
        setData({ overview, monthly });
        setError('');
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [period]);

  // as of today, so it does not depend on the period; a failure here must not break the rest of the page
  useEffect(() => {
    api('/shipments/ready').then((d) => setToShip(d.orders.length)).catch(() => setToShip(null));
  }, []);

  const o = data?.overview;
  const months = data?.monthly.months ?? [];
  const owedPaise = o ? (toPaise(o.owed.to_suppliers) ?? 0) + (toPaise(o.owed.to_couriers) ?? 0) : 0;
  const collectPaise = o ? toPaise(o.owed.to_collect) ?? 0 : 0;

  return (
    <>
      <div className="page-head"><h1>Hello, {user.name}</h1></div>

      <PeriodPicker preset={preset} setPreset={setPreset} custom={custom} setCustom={setCustom} period={period} />

      {/* Space kept for the "Ask about your shop" assistant (planned, not built yet). */}

      {toShip !== null && (toShip > 0 ? (
        <Link to="/shipping" className="stat-tile card-link dash-ship">
          <span className="tile-label">Pending shipments</span>
          <strong>{toShip}</strong>
          <span className="muted tile-note">{toShip === 1 ? 'order is' : 'orders are'} waiting to be shipped. Open Shipping</span>
        </Link>
      ) : (
        <div className="stat-tile dash-ship">
          <span className="tile-label">Pending shipments</span>
          <strong>0</strong>
          <span className="muted tile-note">Nothing waiting to ship</span>
        </div>
      ))}

      {error && <div className="alert error" role="alert">{error}</div>}
      {!data && !error && <div className="loading">Loading...</div>}

      {data && (
        <div className={`dash ${loading ? 'refetching' : ''}`}>
          <section className="card dash-card">
            <h2>Sales and profit</h2>
            <div className="dash-pair">
              <div>
                <span className="tile-label">Sales</span>
                <strong className="dash-big">{formatInrText(o.sales.sales)}</strong>
                <span className="muted tile-note">{plural(o.sales.orders, 'order', 'orders')}, {plural(o.sales.pieces, 'piece', 'pieces')}</span>
              </div>
              <div>
                <span className="tile-label">Profit</span>
                <strong className={`dash-big ${o.sales.profit.startsWith('-') ? 'bad-text' : ''}`}>{formatInrText(o.sales.profit)}</strong>
                <span className="muted tile-note">{o.sales.margin_percent === null ? 'no sales yet' : `${o.sales.margin_percent}% of sales`}</span>
              </div>
            </div>
            {o.sales.margin_percent !== null && (
              <div className="meter" role="img" aria-label={`Profit is ${o.sales.margin_percent}% of sales`}>
                <span className="meter-fill" style={{ width: `${Math.min(100, Math.max(0, Number(o.sales.margin_percent)))}%`, background: ORANGE }} />
              </div>
            )}
            <Sparkline months={months.map((m) => m.month)} values={months.map((m) => m.sales)} color={BLUE} label="Sales" />
          </section>

          <section className="card dash-card">
            <h2>Money in and out</h2>
            <CompareBars rows={[
              { label: 'Money in', note: 'from customers', value: o.money.in, color: BLUE },
              { label: 'Money out', note: 'suppliers, couriers, refunds', value: o.money.out, color: ORANGE },
            ]} />
            <p className="dash-net">
              Net cash <strong className={o.money.net.startsWith('-') ? 'bad-text' : 'good-text'}>{signed(o.money.net)}</strong>
            </p>
          </section>

          <section className="card dash-card">
            <h2>Right now</h2>
            <Link to="/inventory" className="dash-stock card-link">
              <span className="tile-label">Stock value</span>
              <strong className="dash-big">{formatInrText(o.stock.value)}</strong>
              <span className="muted tile-note">{plural(o.stock.pieces, 'piece', 'pieces')}, at cost</span>
            </Link>
            <CompareBars rows={[
              { label: 'You owe suppliers', note: plural(o.owed.supplier_purchases, 'unpaid purchase', 'unpaid purchases'), value: o.owed.to_suppliers, color: ORANGE, to: '/purchases' },
              { label: 'You owe couriers', note: 'not yet settled', value: o.owed.to_couriers, color: ORANGE, to: '/shipping?tab=courier' },
              { label: 'To collect from customers', note: plural(o.owed.orders_to_collect, 'order', 'orders'), value: o.owed.to_collect, color: BLUE, to: '/orders' },
            ]} />
            <p className="muted tile-note">You owe {formatInr(owedPaise)}; customers owe you {formatInr(collectPaise)}.</p>
          </section>

          <p className="muted"><Link to="/reports">See full reports</Link></p>
        </div>
      )}
    </>
  );
}
