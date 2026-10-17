import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatInrText } from '../money.js';
import { useLookups } from '../useLookups.js';
import AdjustStockDialog from '../components/AdjustStockDialog.jsx';
import MovementHistory from '../components/MovementHistory.jsx';
import StockBadge from '../components/StockBadge.jsx';

const NO_FILTERS = { search: '', product: '', fabric: '', size: '', colour: '', stock: 'all', inactive: false };

export default function Inventory() {
  const { lookups } = useLookups();
  const [filters, setFilters] = useState(NO_FILTERS);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [adjusting, setAdjusting] = useState(null); // variant being adjusted
  const [viewing, setViewing] = useState(null); // variant whose history is open

  const setFilter = (field) => (value) => setFilters((f) => ({ ...f, [field]: value }));

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== '' && value !== false) params.set(key, String(value));
    }
    try {
      setData(await api(`/inventory?${params}`));
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
    const timer = setTimeout(() => setFlash(''), 6000);
    return () => clearTimeout(timer);
  }, [flash]);

  const hasFilters = Object.entries(filters).some(([k, v]) => (k === 'stock' ? v !== 'all' : v !== '' && v !== false));
  const variants = data?.variants;

  const actions = (v) => (
    <div className="row-actions">
      {v.is_active && <button className="btn small" onClick={() => setAdjusting(v)}>Adjust</button>}
      <button className="btn secondary small" onClick={() => setViewing(v)}>History</button>
    </div>
  );

  return (
    <>
      <div className="page-head">
        <h1>Inventory</h1>
      </div>

      {flash && <div className="alert ok" role="status">{flash}</div>}
      {error && <div className="alert error" role="alert">{error}</div>}

      {data && (
        <div className="tiles summary">
          <div className="tile"><strong>{data.totals.pieces}</strong>pieces in stock</div>
          <div className="tile"><strong>{formatInrText(data.totals.value)}</strong>stock value (at cost)</div>
        </div>
      )}

      <div className="card filters">
        <div className="field grow">
          <label htmlFor="search">Search</label>
          <input id="search" type="search" placeholder="SKU, product, fabric or colour" value={filters.search} onChange={(e) => setFilter('search')(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="f-product">Product</label>
          <select id="f-product" value={filters.product} onChange={(e) => setFilter('product')(e.target.value)}>
            <option value="">All</option>
            {lookups?.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-fabric">Fabric</label>
          <select id="f-fabric" value={filters.fabric} onChange={(e) => setFilter('fabric')(e.target.value)}>
            <option value="">All</option>
            {lookups?.fabrics.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-size">Size</label>
          <select id="f-size" value={filters.size} onChange={(e) => setFilter('size')(e.target.value)}>
            <option value="">All</option>
            {lookups?.sizes.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-colour">Colour</label>
          <select id="f-colour" value={filters.colour} onChange={(e) => setFilter('colour')(e.target.value)}>
            <option value="">All</option>
            {lookups?.colours.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-stock">Stock</label>
          <select id="f-stock" value={filters.stock} onChange={(e) => setFilter('stock')(e.target.value)}>
            <option value="all">All</option>
            <option value="in">In stock</option>
            <option value="out">Out of stock</option>
          </select>
        </div>
        <div className="filter-foot">
          <label className="check">
            <input type="checkbox" checked={filters.inactive} onChange={(e) => setFilter('inactive')(e.target.checked)} />
            Show hidden variants
          </label>
          {hasFilters && <button type="button" className="linkbtn" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
        </div>
      </div>

      {!data && !error && <div className="loading">Loading...</div>}

      {variants && (
        <>
          <p className="muted count">{variants.length} {variants.length === 1 ? 'variant' : 'variants'}</p>
          {variants.length === 0 && (
            <div className="card empty">
              <p>No variants match.</p>
              {hasFilters && <button className="btn secondary" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
            </div>
          )}

          {variants.length > 0 && (
            <>
              <div className="only-wide card table-card">
                <table>
                  <thead>
                    <tr><th>SKU</th><th>Product</th><th>Fabric</th><th>Size</th><th>Colour</th><th className="num">Cost</th><th>Stock</th><th className="num">Value</th><th /></tr>
                  </thead>
                  <tbody>
                    {variants.map((v) => (
                      <tr key={v.variant_id} className={v.is_active ? '' : 'inactive'}>
                        <td><strong>{v.sku}</strong>{!v.is_active && <span className="badge muted-badge">Hidden</span>}</td>
                        <td>{v.product_name}</td>
                        <td>{v.fabric}</td>
                        <td>{v.size}</td>
                        <td>{v.colour}</td>
                        <td className="num">{formatInrText(v.unit_cost)}</td>
                        <td><StockBadge onHand={v.on_hand} /></td>
                        <td className="num">{formatInrText(v.stock_value)}</td>
                        <td>{actions(v)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="only-narrow cards">
                {variants.map((v) => (
                  <div className={`card variant-card${v.is_active ? '' : ' inactive'}`} key={v.variant_id}>
                    <div className="variant-card-head">
                      <strong>{v.sku}</strong>
                      {!v.is_active && <span className="badge muted-badge">Hidden</span>}
                      <StockBadge onHand={v.on_hand} />
                    </div>
                    <div>{v.product_name}</div>
                    <div className="muted">{v.fabric} &middot; {v.size} &middot; {v.colour}</div>
                    <dl className="money-list">
                      <div><dt>Cost</dt><dd>{formatInrText(v.unit_cost)}</dd></div>
                      <div><dt>On hand</dt><dd>{v.on_hand}</dd></div>
                      <div><dt>Value</dt><dd>{formatInrText(v.stock_value)}</dd></div>
                    </dl>
                    {actions(v)}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {adjusting && (
        <AdjustStockDialog
          variant={adjusting}
          onClose={() => setAdjusting(null)}
          onSaved={async (message) => {
            setAdjusting(null);
            setFlash(message);
            await load();
          }}
        />
      )}
      {viewing && <MovementHistory variant={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
