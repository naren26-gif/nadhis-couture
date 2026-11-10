import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { INDIAN_STATES, PARTY_KINDS } from '../partyKinds.js';

const EMPTY = {
  name: '', contact_person: '', phone: '', email: '', location: '',
  address_line1: '', address_line2: '', city: '', state: '', country: 'India', pincode: '',
};

// "Add" (/suppliers/new) and "Edit" (/suppliers/:id/edit) for both suppliers and customers.
export default function PartyFormPage({ kind }) {
  const k = PARTY_KINDS[kind];
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();

  const [form, setForm] = useState(EMPTY);
  const [countries, setCountries] = useState(['India']);
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
          address_line1: item.address_line1 || '',
          address_line2: item.address_line2 || '',
          city: item.city || '',
          state: item.state || '',
          country: item.country || 'India',
          pincode: item.pincode || '',
        });
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [editing, id, k.path]);

  useEffect(() => {
    if (!k.hasAddress) return;
    api(`${k.path}/countries`).then(({ countries: list }) => setCountries(list)).catch(() => {});
  }, [k.hasAddress, k.path]);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const india = form.country === 'India';
  // India's states come from a list; another country's region is typed, so clear a state that no longer fits
  const changeCountry = (e) => {
    const country = e.target.value;
    setForm((f) => ({ ...f, country, state: (country === 'India') === (f.country === 'India') ? f.state : '' }));
  };

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = { name: form.name, phone: form.phone, email: form.email, location: form.location };
      if (k.hasContactPerson) body.contact_person = form.contact_person;
      if (k.hasAddress) {
        for (const f of ['address_line1', 'address_line2', 'city', 'state', 'country', 'pincode']) body[f] = form[f];
      }
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
              <label htmlFor="phone">{k.hasAddress ? 'Phone' : 'Phone (optional)'}</label>
              <input id="phone" type="tel" inputMode="tel" value={form.phone} onChange={set('phone')} maxLength={20} required={k.hasAddress} />
              <div className="hint">
                Digits, spaces, + ( ) -. For example +91 98765 43210
                {k.hasAddress && '. Each customer needs their own number.'}
              </div>
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
          {k.hasAddress && (
            <>
              <h2>Delivery address</h2>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="address1">Address line 1</label>
                  <input id="address1" type="text" value={form.address_line1} onChange={set('address_line1')} maxLength={150} required />
                </div>
                <div className="field">
                  <label htmlFor="address2">Address line 2 (optional)</label>
                  <input id="address2" type="text" value={form.address_line2} onChange={set('address_line2')} maxLength={150} />
                </div>
                <div className="field">
                  <label htmlFor="city">City</label>
                  <input id="city" type="text" value={form.city} onChange={set('city')} maxLength={80} required />
                </div>
                <div className="field">
                  <label htmlFor="country">Country</label>
                  <select id="country" value={form.country} onChange={changeCountry} required>
                    {countries.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="state">{india ? 'State' : 'State / region'}</label>
                  {india ? (
                    <select id="state" value={form.state} onChange={set('state')} required>
                      <option value="">Choose...</option>
                      {form.state && !INDIAN_STATES.includes(form.state) && <option value={form.state}>{form.state}</option>}
                      {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  ) : (
                    <input id="state" type="text" value={form.state} onChange={set('state')} maxLength={60} required />
                  )}
                </div>
                <div className="field">
                  <label htmlFor="pincode">{india ? 'PIN code' : 'Postal code'}</label>
                  <input id="pincode" type="text" inputMode={india ? 'numeric' : 'text'} value={form.pincode} onChange={set('pincode')} maxLength={india ? 6 : 10} required />
                  <div className="hint">{india ? '6 digits' : '3 to 10 letters or digits'}</div>
                </div>
              </div>
            </>
          )}
          <div className="actions">
            <button type="button" className="btn secondary" onClick={() => navigate(k.path)}>Cancel</button>
            <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
          </div>
        </form>
      )}
    </>
  );
}
