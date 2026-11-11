import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { INDIAN_STATES } from '../partyKinds.js';

// A customer's ONE delivery address, shared by the Customers form and the "add customer" pop-up on the order form.
// It edits these keys of `form` (the caller keeps the rest, e.g. name and phone).
export const EMPTY_ADDRESS = { address_line1: '', address_line2: '', city: '', state: '', country: 'India', pincode: '' };
export const ADDRESS_KEYS = Object.keys(EMPTY_ADDRESS);

export const phoneHint = (country) =>
  country === 'India'
    ? '10 digits, for example 98765 43210. Each customer needs their own number.'
    : 'Start with the country code, for example +44 7700 900123.';

let countryList = null; // the list never changes while the app is open, so it is fetched once

// Renders the fields only (the caller wraps them in a grid or a plain column). idPrefix keeps ids unique on a page.
export default function AddressFields({ form, setForm, idPrefix = '' }) {
  const [countries, setCountries] = useState(countryList || ['India']);

  useEffect(() => {
    if (countryList) return;
    api('/customers/countries')
      .then(({ countries: list }) => {
        countryList = list;
        setCountries(list);
      })
      .catch(() => {});
  }, []);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const india = form.country === 'India';
  // India's states come from a list; another country's region is typed, so clear a state that no longer fits
  const changeCountry = (e) => {
    const country = e.target.value;
    setForm((f) => ({ ...f, country, state: (country === 'India') === (f.country === 'India') ? f.state : '' }));
  };

  return (
    <>
      <div className="field">
        <label htmlFor={`${idPrefix}address1`}>Address line 1</label>
        <input id={`${idPrefix}address1`} type="text" value={form.address_line1} onChange={set('address_line1')} maxLength={150} required />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}address2`}>Address line 2 (optional)</label>
        <input id={`${idPrefix}address2`} type="text" value={form.address_line2} onChange={set('address_line2')} maxLength={150} />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}city`}>City</label>
        <input id={`${idPrefix}city`} type="text" value={form.city} onChange={set('city')} maxLength={80} required />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}country`}>Country</label>
        <select id={`${idPrefix}country`} value={form.country} onChange={changeCountry} required>
          {countries.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}state`}>{india ? 'State' : 'State / region'}</label>
        {india ? (
          <select id={`${idPrefix}state`} value={form.state} onChange={set('state')} required>
            <option value="">Choose...</option>
            {form.state && !INDIAN_STATES.includes(form.state) && <option value={form.state}>{form.state}</option>}
            {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        ) : (
          <input id={`${idPrefix}state`} type="text" value={form.state} onChange={set('state')} maxLength={60} required />
        )}
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}pincode`}>{india ? 'PIN code' : 'Postal code'}</label>
        <input id={`${idPrefix}pincode`} type="text" inputMode={india ? 'numeric' : 'text'} value={form.pincode} onChange={set('pincode')} maxLength={india ? 6 : 10} required />
        <div className="hint">{india ? '6 digits' : '3 to 10 letters or digits'}</div>
      </div>
    </>
  );
}
