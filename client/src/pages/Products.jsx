import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { formatInrText } from '../money.js';
import { useLookups } from '../useLookups.js';
import Modal from '../components/Modal.jsx';

function StockBadge({ onHand }) {
  if (onHand <= 0) return <span className="badge bad">Out of stock</span>;
  if (onHand <= 2) return <span className="badge warn">{onHand} left</span>;
  return <span className="badge good">{onHand} in stock</span>;
}

function MarginCell({ variant }) {
  const negative = variant.margin.startsWith('-');
  return (
    <span className={negative ? 'bad-text' : ''}>
      {formatInrText(variant.margin)}
      {variant.margin_percent !== null && <span className="muted"> ({variant.margin_percent}%)</span>}
    </span>
  );
}

export default function Products() {
  const { user } = useAuth();
  const isOwner = user.role === 'owner';
  const location = useLocation();
  const { lookups } = useLookups();

  const [filters, setFilters] = useState({ search: '', product: '', fabric: '', size: '', colour: '', stock: 'all', inactive: false });
  const [variants, setVariants] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(location.state?.flash || '');
  const [confirm, setConfirm] = useState(null); // variant about to be hidden
  const [busy, setBusy] = useState(false);

  const setFilter = (field) => (value) => setFilters((f) => ({ ...f, [field]: value }));

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== '' && value !== false) params.set(key, String(value));
    }
    try {
      const data = await api(`/variants?${params}`);
      setVariants(data.variants);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [filters]);

  // reload when a filter changes (typing in the search box waits a moment so we do not ask on every key press)
  useEffect(() => {
    const timer = setTimeout(load, filters.search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, filters.search]);

  // the "Saved ..." message from the form disappears on its own
  useEffect(() => {
    if (!flash) return undefined;
    window.history.replaceState({}, '');
    const timer = setTimeout(() => setFlash(''), 6000);
    return () => clearTimeout(timer);
  }, [flash]);

  async function setActive(variant, active) {
    setBusy(true);
    setError('');
    try {
      await api(`/variants/${variant.variant_id}/${active ? 'activate' : 'deactivate'}`, { method: 'POST' });
      setFlash(`${variant.sku} is now ${active ? 'shown again' : 'hidden'}.`);
      setConfirm(null);
      await load();
    } catch (err) {
      setError(err.message);
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  const hasFilters = Object.entries(filters).some(([k, v]) => (k === 'stock' ? v !== 'all' : v !== '' && v !== false));
  const clear = () => setFilters({ search: '', product: '', fabric: '', size: '', colour: '', stock: 'all', inactive: false });

  const actions = (v) => (
    <div className="row-actions">
      <Link className="btn secondary small" to={`/products/${v.variant_id}/edit`}>Edit</Link>
      {isOwner && (
        v.is_active ? (
          <button className="btn secondary small" onClick={() => setConfirm(v)}>Hide</button>
        ) : (
          <button className="btn secondary small" disabled={busy} onClick={() => setActive(v, true)}>Show again</button>
        )
      )}
    </div>
  );

  return (
    <>
      <div className="page-head">
        <h1>Products</h1>
        <Link className="btn" to="/products/new">+ Add product</Link>
      </div>

      {flash && <div className="alert ok" role="status">{flash}</div>}
      {error && <div className="alert error" role="alert">{error}</div>}

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
          {hasFilters && <button type="button" className="linkbtn" onClick={clear}>Clear filters</button>}
        </div>
      </div>

      {!variants && !error && <div className="loading">Loading...</div>}

      {variants && (
        <>
          <p className="muted count">{variants.length} {variants.length === 1 ? 'variant' : 'variants'}</p>
          {variants.length === 0 && (
            <div className="card empty">
              <p>No products match.</p>
              {hasFilters ? <button className="btn secondary" onClick={clear}>Clear filters</button> : <Link className="btn" to="/products/new">Add your first product</Link>}
            </div>
          )}

          {variants.length > 0 && (
            <>
              <div className="only-wide card table-card">
                <table>
                  <thead>
                    <tr><th>SKU</th><th>Product</th><th>Fabric</th><th>Size</th><th>Colour</th><th className="num">Cost</th><th className="num">Price</th><th className="num">Margin</th><th>Stock</th><th /></tr>
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
                        <td className="num">{formatInrText(v.list_price)}</td>
                        <td className="num"><MarginCell variant={v} /></td>
                        <td><StockBadge onHand={v.on_hand} /></td>
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
                      <div><dt>Price</dt><dd>{formatInrText(v.list_price)}</dd></div>
                      <div><dt>Margin</dt><dd><MarginCell variant={v} /></dd></div>
                    </dl>
                    {actions(v)}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {confirm && (
        <Modal title={`Hide ${confirm.sku}?`} onClose={() => setConfirm(null)}>
          <p>
            It will disappear from the list and from new orders. Nothing is deleted, and you can show it again any time
            with "Show hidden variants".
          </p>
          {confirm.on_hand > 0 && (
            <div className="alert warn">
              {confirm.on_hand} {confirm.on_hand === 1 ? 'piece is' : 'pieces are'} still in stock for this variant.
            </div>
          )}
          <div className="actions">
            <button className="btn secondary" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn" disabled={busy} onClick={() => setActive(confirm, false)}>{busy ? 'Hiding...' : 'Hide it'}</button>
          </div>
        </Modal>
      )}
    </>
  );
}
