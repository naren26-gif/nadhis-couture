import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { formatInrText } from '../money.js';
import { defaultCustom, periodOf, periodQuery } from '../periods.js';
import MonthlyBarChart, { monthLong } from '../components/MonthlyBarChart.jsx';
import PeriodPicker from '../components/PeriodPicker.jsx';

// Series colours: validated categorical slots 1 and 2 (blue, orange) on the white card surface.
const BLUE = '#2a78d6';
const ORANGE = '#eb6834';

export default function Reports() {
  const [preset, setPreset] = useState('last_6');
  const [custom, setCustom] = useState(defaultCustom);
  const [productGroup, setProductGroup] = useState('product');
  const [stockGroup, setStockGroup] = useState('product');
  const [showMatrix, setShowMatrix] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const period = useMemo(() => periodOf(preset, custom), [preset, custom]);

  useEffect(() => {
    let cancelled = false;
    const q = periodQuery(period);
    const withGroup = (group) => { const p = new URLSearchParams(q); p.set('group', group); return p; };
    setLoading(true);
    Promise.all([
      api(`/reports/overview?${q}`),
      api(`/reports/monthly?${q}`),
      api(`/reports/products?${withGroup(productGroup)}`),
      showMatrix ? api(`/reports/product-months?${q}`) : Promise.resolve(null),
      api(`/reports/stock?group=${stockGroup}`),
      api('/reports/payables'),
    ])
      .then(([overview, monthly, products, matrix, stock, payables]) => {
        if (cancelled) return;
        setData({ overview, monthly, products, matrix, stock, payables });
        setError('');
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [period, productGroup, stockGroup, showMatrix]);

  const o = data?.overview;
  const months = data?.monthly.months ?? [];
  const showExpenses = months.some((m) => Number(m.expenses) > 0);

  return (
    <>
      <div className="page-head"><h1>Reports</h1></div>

      <PeriodPicker preset={preset} setPreset={setPreset} custom={custom} setCustom={setCustom} period={period} />

      {error && <div className="alert error" role="alert">{error}</div>}
      {!data && !error && <div className="loading">Loading...</div>}

      {data && (
        <div className={loading ? 'refetching' : ''}>
          {data.monthly.truncated && <div className="alert warn">That period is very long, so only the latest 60 months are shown in the month tables and charts.</div>}

          <section className="card report-card">
            <h2>Sales and profit by month</h2>
            <p className="muted">Sales are by the month the order was placed. Shipping is not counted as sales.{Number(o.sales.in_orders_to_ship) > 0 && <> {formatInrText(o.sales.in_orders_to_ship)} of the sales is in orders that have not fully shipped yet.</>}</p>
            <MonthlyBarChart title="Sales and profit by month" months={months.map((m) => m.month)} a={{ name: 'Sales', color: BLUE, values: months.map((m) => m.sales) }} b={{ name: 'Profit', color: ORANGE, values: months.map((m) => m.profit) }} />
            <div className="table-card">
              <table>
                <thead><tr><th>Month</th><th className="num">Orders</th><th className="num">Pieces</th><th className="num">Sales</th><th className="num">Cost</th><th className="num">Profit</th><th className="num">Margin</th></tr></thead>
                <tbody>
                  {months.map((m) => (
                    <tr key={m.month}><td>{monthLong(m.month)}</td><td className="num">{m.orders}</td><td className="num">{m.pieces}</td><td className="num">{formatInrText(m.sales)}</td><td className="num">{formatInrText(m.cost)}</td><td className={`num ${m.profit.startsWith('-') ? 'bad-text' : ''}`}>{formatInrText(m.profit)}</td><td className="num">{m.margin_percent === null ? '-' : `${m.margin_percent}%`}</td></tr>
                  ))}
                  <tr className="total-row"><td>Total</td><td className="num">{o.sales.orders}</td><td className="num">{o.sales.pieces}</td><td className="num">{formatInrText(o.sales.sales)}</td><td className="num">{formatInrText(o.sales.cost)}</td><td className="num">{formatInrText(o.sales.profit)}</td><td className="num">{o.sales.margin_percent === null ? '-' : `${o.sales.margin_percent}%`}</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="card report-card">
            <h2>Money in and out by month</h2>
            <p className="muted">Counted on the day each payment was made. Money out is what you paid suppliers and couriers, plus refunds.</p>
            <MonthlyBarChart title="Money in and out by month" months={months.map((m) => m.month)} a={{ name: 'Money in', color: BLUE, values: months.map((m) => m.money_in) }} b={{ name: 'Money out', color: ORANGE, values: months.map((m) => m.money_out) }} />
            <div className="table-card">
              <table>
                <thead><tr><th>Month</th><th className="num">In</th><th className="num">Suppliers</th><th className="num">Couriers</th><th className="num">Refunds</th>{showExpenses && <th className="num">Expenses</th>}<th className="num">Out</th><th className="num">Net</th></tr></thead>
                <tbody>
                  {months.map((m) => (
                    <tr key={m.month}><td>{monthLong(m.month)}</td><td className="num">{formatInrText(m.money_in)}</td><td className="num">{formatInrText(m.to_suppliers)}</td><td className="num">{formatInrText(m.to_couriers)}</td><td className="num">{formatInrText(m.refunds)}</td>{showExpenses && <td className="num">{formatInrText(m.expenses)}</td>}<td className="num">{formatInrText(m.money_out)}</td><td className={`num ${m.net.startsWith('-') ? 'bad-text' : ''}`}>{formatInrText(m.net)}</td></tr>
                  ))}
                  <tr className="total-row"><td>Total</td><td className="num">{formatInrText(o.money.in)}</td><td className="num">{formatInrText(o.money.to_suppliers)}</td><td className="num">{formatInrText(o.money.to_couriers)}</td><td className="num">{formatInrText(o.money.refunds)}</td>{showExpenses && <td className="num">{formatInrText(o.money.expenses)}</td>}<td className="num">{formatInrText(o.money.out)}</td><td className="num">{formatInrText(o.money.net)}</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="card report-card">
            <h2>Sales and profit by product</h2>
            <div className="report-controls">
              <div className="seg tabs small-seg" role="group" aria-label="Group by">
                <button type="button" className={productGroup === 'product' ? 'on' : ''} onClick={() => setProductGroup('product')}>By product</button>
                <button type="button" className={productGroup === 'variant' ? 'on' : ''} onClick={() => setProductGroup('variant')}>By SKU</button>
              </div>
              <label className="check"><input type="checkbox" checked={showMatrix} onChange={(e) => setShowMatrix(e.target.checked)} />Also show each month</label>
            </div>
            {data.products.items.length === 0 ? <p className="muted">No orders in this period.</p> : (
              <div className="table-card">
                <table>
                  <thead><tr><th>{productGroup === 'product' ? 'Product' : 'SKU'}</th><th className="num">Pieces</th><th className="num">Sales</th><th className="num">Cost</th><th className="num">Profit</th><th className="num">Margin</th><th className="num">Share of sales</th></tr></thead>
                  <tbody>
                    {data.products.items.map((p) => (
                      <tr key={p.id}><td>{p.name}</td><td className="num">{p.pieces}</td><td className="num">{formatInrText(p.sales)}</td><td className="num">{formatInrText(p.cost)}</td><td className={`num ${p.profit.startsWith('-') ? 'bad-text' : ''}`}>{formatInrText(p.profit)}</td><td className="num">{p.margin_percent === null ? '-' : `${p.margin_percent}%`}</td><td className="num">{p.share_percent === null ? '-' : `${p.share_percent}%`}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {showMatrix && data.matrix && data.matrix.products.length > 0 && (
              <>
                <h3 className="dialog-h">Sales by month (profit in brackets)</h3>
                <div className="table-card">
                  <table>
                    <thead><tr><th>Product</th>{data.matrix.months.map((m) => <th key={m} className="num">{monthLong(m)}</th>)}<th className="num">Total</th></tr></thead>
                    <tbody>
                      {data.matrix.products.map((p) => (
                        <tr key={p.id}>
                          <td>{p.name}</td>
                          {p.cells.map((c, i) => <td key={data.matrix.months[i]} className="num">{Number(c.sales) === 0 ? <span className="muted">-</span> : <>{formatInrText(c.sales)}<span className="muted block">({formatInrText(c.profit)})</span></>}</td>)}
                          <td className="num"><strong>{formatInrText(p.total_sales)}</strong><span className="muted block">({formatInrText(p.total_profit)})</span></td>
                        </tr>
                      ))}
                      <tr className="total-row"><td>Total</td>{data.matrix.column_totals.map((c, i) => <td key={data.matrix.months[i]} className="num">{formatInrText(c.sales)}<span className="muted block">({formatInrText(c.profit)})</span></td>)}<td className="num">{formatInrText(o.sales.sales)}<span className="muted block">({formatInrText(o.sales.profit)})</span></td></tr>
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>

          <section className="card report-card">
            <h2>Shipping charged and courier cost</h2>
            <p className="muted">Shipping is passed on to customers, not counted as sales. Months are by the day the parcel was sent.</p>
            <div className="table-card">
              <table>
                <thead><tr><th>Month</th><th className="num">Charged to customers</th><th className="num">Courier cost</th><th className="num">Difference</th></tr></thead>
                <tbody>
                  {months.map((m) => (
                    <tr key={m.month}><td>{monthLong(m.month)}</td><td className="num">{formatInrText(m.ship_charged)}</td><td className="num">{formatInrText(m.ship_cost)}</td><td className={`num ${m.ship_difference.startsWith('-') ? 'bad-text' : ''}`}>{formatInrText(m.ship_difference)}</td></tr>
                  ))}
                  <tr className="total-row"><td>Total</td><td className="num">{formatInrText(o.shipping.charged)}</td><td className="num">{formatInrText(o.shipping.courier_cost)}</td><td className="num">{formatInrText(o.shipping.difference)}</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="card report-card">
            <h2>Stock on hand</h2>
            <div className="report-controls">
              <div className="seg tabs small-seg" role="group" aria-label="Group stock by">
                <button type="button" className={stockGroup === 'product' ? 'on' : ''} onClick={() => setStockGroup('product')}>By product</button>
                <button type="button" className={stockGroup === 'variant' ? 'on' : ''} onClick={() => setStockGroup('variant')}>By SKU</button>
              </div>
              <span className="muted">Value is at your cost price. Hidden products that still hold stock are included.</span>
            </div>
            <div className="table-card">
              <table>
                <thead><tr><th>{stockGroup === 'product' ? 'Product' : 'SKU'}</th>{stockGroup === 'product' && <th className="num">Variants</th>}<th className="num">On hand</th><th className="num">Value</th></tr></thead>
                <tbody>
                  {data.stock.items.map((s) => (
                    <tr key={s.name}><td>{s.name}</td>{stockGroup === 'product' && <td className="num">{s.variants}</td>}<td className="num">{s.on_hand}</td><td className="num">{formatInrText(s.value)}</td></tr>
                  ))}
                  <tr className="total-row"><td>Total</td>{stockGroup === 'product' && <td />}<td className="num">{data.stock.totals.on_hand}</td><td className="num">{formatInrText(data.stock.totals.value)}</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="card report-card">
            <h2>Who you owe, and who owes you</h2>
            <h3 className="dialog-h">Suppliers (unpaid purchases)</h3>
            {data.payables.purchases.length === 0 ? <p className="muted">Nothing owed to suppliers.</p> : (
              <div className="table-card">
                <table>
                  <thead><tr><th>Purchase</th><th>Supplier</th><th>Date</th><th className="num">Total</th><th className="num">Paid</th><th className="num">Owed</th></tr></thead>
                  <tbody>
                    {data.payables.purchases.map((p) => (
                      <tr key={p.id}><td><Link to={`/purchases/${p.id}`}><strong>{p.code}</strong></Link></td><td>{p.supplier}</td><td>{p.order_date}</td><td className="num">{formatInrText(p.total)}</td><td className="num">{formatInrText(p.paid)}</td><td className="num"><strong>{formatInrText(p.balance)}</strong></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <h3 className="dialog-h">Couriers (not yet settled)</h3>
            {data.payables.couriers.length === 0 ? <p className="muted">Nothing owed to couriers.</p> : (
              <div className="table-card">
                <table>
                  <thead><tr><th>Courier</th><th>Month</th><th className="num">Parcels</th><th className="num">Owed</th><th /></tr></thead>
                  <tbody>
                    {data.payables.couriers.map((c) => (
                      <tr key={`${c.courier_id}-${c.month}`}><td>{c.courier}</td><td>{monthLong(c.month)}</td><td className="num">{c.parcels}</td><td className="num"><strong>{formatInrText(c.amount_due)}</strong></td><td><Link className="btn secondary small" to="/shipping?tab=courier">Settle</Link></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <h3 className="dialog-h">Customers (still to collect)</h3>
            {data.payables.orders.length === 0 ? <p className="muted">No customer owes you anything.</p> : (
              <div className="table-card">
                <table>
                  <thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Status</th><th className="num">Total</th><th className="num">Received</th><th className="num">To collect</th></tr></thead>
                  <tbody>
                    {data.payables.orders.map((x) => (
                      <tr key={x.id}><td><Link to={`/orders/${x.id}`}><strong>{x.code}</strong></Link></td><td>{x.customer}</td><td>{x.order_date}</td><td>{x.status}</td><td className="num">{formatInrText(x.order_total)}</td><td className="num">{formatInrText(x.received)}</td><td className="num"><strong>{formatInrText(x.balance)}</strong></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
