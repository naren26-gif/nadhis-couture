import { useState } from 'react';
import { api } from '../api.js';
import Modal from './Modal.jsx';

const REASONS = ['Stock count correction', 'Damaged', 'Found extra', 'Sample / gift', 'Lost'];

// Pop-up to add or remove stock. Nothing is edited: the server records a new Adjustment line in the stock history.
export default function AdjustStockDialog({ variant, onSaved, onClose }) {
  const [direction, setDirection] = useState('add');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const qty = /^\d+$/.test(quantity) ? Number(quantity) : 0;
  const after = variant.on_hand + (direction === 'add' ? qty : -qty);
  const tooMany = direction === 'remove' && qty > variant.on_hand;
  const valid = qty >= 1 && !tooMany && reason.trim().length >= 3;

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/inventory/adjustments', {
        method: 'POST',
        body: { variant_id: variant.variant_id, direction, quantity: qty, reason },
      });
      onSaved(`${variant.sku}: stock is now ${after}.`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`Adjust stock: ${variant.sku}`} onClose={onClose}>
      <form onSubmit={submit}>
        {error && <div className="alert error" role="alert">{error}</div>}
        <p className="muted">
          {variant.product_name} &middot; {variant.fabric} &middot; {variant.size} &middot; {variant.colour}
          <br />
          Now in stock: <strong>{variant.on_hand}</strong>
        </p>

        <div className="seg" role="group" aria-label="Add or remove">
          <button type="button" className={direction === 'add' ? 'on' : ''} onClick={() => setDirection('add')}>Add stock</button>
          <button type="button" className={direction === 'remove' ? 'on' : ''} onClick={() => setDirection('remove')}>Remove stock</button>
        </div>

        <div className="field">
          <label htmlFor="adj-qty">How many pieces?</label>
          <input id="adj-qty" type="text" inputMode="numeric" value={quantity} autoFocus
            onChange={(e) => setQuantity(e.target.value.trim())} />
          {tooMany && <div className="hint bad-text">Not enough stock: only {variant.on_hand} left</div>}
          {qty >= 1 && !tooMany && <div className="hint">Stock will be {after}.</div>}
        </div>

        <div className="field">
          <label htmlFor="adj-reason">Reason (required)</label>
          <input id="adj-reason" type="text" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="chips">
            {REASONS.map((r) => (
              <button type="button" key={r} className="chip" onClick={() => setReason(r)}>{r}</button>
            ))}
          </div>
        </div>

        <div className="actions">
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={busy || !valid}>{busy ? 'Saving...' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}
