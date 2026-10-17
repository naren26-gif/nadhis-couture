import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Modal from '../components/Modal.jsx';
import { PARTY_KINDS } from '../partyKinds.js';

// One list screen for both suppliers and customers (kind = 'supplier' | 'customer').
export default function Parties({ kind }) {
  const k = PARTY_KINDS[kind];
  const { user } = useAuth();
  const isOwner = user.role === 'owner';
  const location = useLocation();

  const [search, setSearch] = useState('');
  const [inactive, setInactive] = useState(false);
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(location.state?.flash || '');
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (inactive) params.set('inactive', 'true');
    try {
      setItems((await api(`${k.path}?${params}`)).items);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [k.path, search, inactive]);

  // start fresh when switching between the supplier and customer screens
  useEffect(() => {
    setItems(null);
    setSearch('');
    setInactive(false);
  }, [kind]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  useEffect(() => {
    if (!flash) return undefined;
    window.history.replaceState({}, '');
    const timer = setTimeout(() => setFlash(''), 6000);
    return () => clearTimeout(timer);
  }, [flash]);

  async function setActive(item, active) {
    setBusy(true);
    setError('');
    try {
      await api(`${k.path}/${item.id}/${active ? 'activate' : 'deactivate'}`, { method: 'POST' });
      setFlash(`${item.name} is now ${active ? 'shown again' : 'hidden'}.`);
      setConfirm(null);
      await load();
    } catch (err) {
      setError(err.message);
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  const actions = (item) => (
    <div className="row-actions">
      <Link className="btn secondary small" to={`${k.path}/${item.id}/edit`}>Edit</Link>
      {isOwner && (
        item.is_active ? (
          <button className="btn secondary small" onClick={() => setConfirm(item)}>Hide</button>
        ) : (
          <button className="btn secondary small" disabled={busy} onClick={() => setActive(item, true)}>Show again</button>
        )
      )}
    </div>
  );

  const phone = (item) => (item.phone ? <a href={`tel:${item.phone.replace(/\s/g, '')}`}>{item.phone}</a> : <span className="muted">-</span>);

  return (
    <>
      <div className="page-head">
        <h1>{k.plural}</h1>
        <Link className="btn" to={`${k.path}/new`}>+ Add {k.noun}</Link>
      </div>

      {flash && <div className="alert ok" role="status">{flash}</div>}
      {error && <div className="alert error" role="alert">{error}</div>}

      <div className="card filters">
        <div className="field grow">
          <label htmlFor="search">Search</label>
          <input id="search" type="search" placeholder="Name, code, phone or location" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="filter-foot">
          <label className="check">
            <input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} />
            Show hidden {k.plural.toLowerCase()}
          </label>
          {search && <button type="button" className="linkbtn" onClick={() => setSearch('')}>Clear search</button>}
        </div>
      </div>

      {!items && !error && <div className="loading">Loading...</div>}

      {items && (
        <>
          <p className="muted count">{items.length} {items.length === 1 ? k.noun : k.noun + 's'}</p>
          {items.length === 0 && (
            <div className="card empty">
              <p>{search ? `No ${k.noun} matches your search.` : `No ${k.noun}s yet.`}</p>
              {!search && <Link className="btn" to={`${k.path}/new`}>Add your first {k.noun}</Link>}
            </div>
          )}

          {items.length > 0 && (
            <>
              <div className="only-wide card table-card">
                <table>
                  <thead>
                    <tr>
                      <th>Code</th><th>Name</th>{k.hasContactPerson && <th>Contact</th>}<th>Phone</th><th>Email</th><th>Location</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id} className={item.is_active ? '' : 'inactive'}>
                        <td><strong>{item.code}</strong></td>
                        <td>{item.name}{!item.is_active && <span className="badge muted-badge">Hidden</span>}</td>
                        {k.hasContactPerson && <td>{item.contact_person || <span className="muted">-</span>}</td>}
                        <td>{phone(item)}</td>
                        <td>{item.email || <span className="muted">-</span>}</td>
                        <td>{item.location || <span className="muted">-</span>}</td>
                        <td>{actions(item)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="only-narrow cards">
                {items.map((item) => (
                  <div className={`card variant-card${item.is_active ? '' : ' inactive'}`} key={item.id}>
                    <div className="variant-card-head">
                      <strong>{item.name}</strong>
                      {!item.is_active && <span className="badge muted-badge">Hidden</span>}
                      <span className="muted">{item.code}</span>
                    </div>
                    {k.hasContactPerson && item.contact_person && <div>{item.contact_person}</div>}
                    <div>{phone(item)}</div>
                    {item.email && <div className="muted">{item.email}</div>}
                    {item.location && <div className="muted">{item.location}</div>}
                    <div className="top-gap-sm">{actions(item)}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {confirm && (
        <Modal title={`Hide ${confirm.name}?`} onClose={() => setConfirm(null)}>
          <p>{k.hideNote} You can show it again any time with "Show hidden {k.plural.toLowerCase()}".</p>
          <div className="actions">
            <button className="btn secondary" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn" disabled={busy} onClick={() => setActive(confirm, false)}>{busy ? 'Hiding...' : 'Hide it'}</button>
          </div>
        </Modal>
      )}
    </>
  );
}
