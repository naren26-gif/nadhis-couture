import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { PARTY_KINDS } from '../partyKinds.js';

const EMPTY = { name: '', contact_person: '', phone: '', email: '', location: '' };

// "Add" (/suppliers/new) and "Edit" (/suppliers/:id/edit) for both suppliers and customers.
export default function PartyFormPage({ kind }) {
  const k = PARTY_KINDS[kind];
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();

  const [form, setForm] = useState(EMPTY);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(editing);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing) return;
    api(`${k.path}/${id}`)
      .then(({ item }) => {
        setCode(item.code);
        setForm({
          name: item.name,
          contact_person: item.contact_person || '',
          phone: item.phone || '',
          email: item.email || '',
          location: item.location || '',
        });
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [editing, id, k.path]);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = { name: form.name, phone: form.phone, email: form.email, location: form.location };
      if (k.hasContactPerson) body.contact_person = form.contact_person;
      const { item } = await api(editing ? `${k.path}/${id}` : k.path, { method: editing ? 'PATCH' : 'POST', body });
      navigate(k.path, { state: { flash: `Saved ${item.name} (${item.code}).` } });
    } catch (err) {
      setError(err.message);
      setBusy(false);
      window.scrollTo({ top: 0 });
    }
  }

  return (
    <>
      <p><Link to={k.path}>&larr; Back to {k.plural.toLowerCase()}</Link></p>
      <h1>{editing ? `Edit ${k.noun}` : `Add a ${k.noun}`}</h1>
      {error && <div className="alert error" role="alert">{error}</div>}
      {loading && <div className="loading">Loading...</div>}
      {!loading && (editing ? code : true) && (
        <form className="card form-card" onSubmit={submit} noValidate>
          {editing && <p className="muted">Code: <strong>{code}</strong> (never changes)</p>}
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" type="text" value={form.name} onChange={set('name')} maxLength={100} autoFocus required />
          </div>
          <div className="form-grid">
            {k.hasContactPerson && (
              <div className="field">
                <label htmlFor="contact">Contact person (optional)</label>
                <input id="contact" type="text" value={form.contact_person} onChange={set('contact_person')} maxLength={100} />
              </div>
            )}
            <div className="field">
              <label htmlFor="phone">Phone (optional)</label>
              <input id="phone" type="tel" inputMode="tel" value={form.phone} onChange={set('phone')} maxLength={20} />
              <div className="hint">Digits, spaces, + ( ) -. For example +91 98765 43210</div>
            </div>
            <div className="field">
              <label htmlFor="email">Email (optional)</label>
              <input id="email" type="email" value={form.email} onChange={set('email')} maxLength={120} />
            </div>
            <div className="field">
              <label htmlFor="location">Location (optional)</label>
              <input id="location" type="text" value={form.location} onChange={set('location')} maxLength={200} />
            </div>
          </div>
          <div className="actions">
            <button type="button" className="btn secondary" onClick={() => navigate(k.path)}>Cancel</button>
            <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
          </div>
        </form>
      )}
    </>
  );
}
