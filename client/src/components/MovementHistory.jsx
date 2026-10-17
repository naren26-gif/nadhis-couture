import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Modal from './Modal.jsx';

// Pop-up showing the stock history of one variant, newest first.
export default function MovementHistory({ variant, onClose }) {
  const [movements, setMovements] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api(`/inventory/${variant.variant_id}/movements`)
      .then((data) => setMovements(data.movements))
      .catch((err) => setError(err.message));
  }, [variant.variant_id]);

  return (
    <Modal title={`Stock history: ${variant.sku}`} onClose={onClose}>
      {error && <div className="alert error" role="alert">{error}</div>}
      {!movements && !error && <div className="loading">Loading...</div>}
      {movements && movements.length === 0 && <p className="muted">No stock movements yet.</p>}
      {movements && movements.length > 0 && (
        <ul className="history">
          {movements.map((m) => (
            <li key={m.movement_id}>
              <span className={`qty ${m.quantity > 0 ? 'good-text' : 'bad-text'}`}>{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</span>
              <span>
                <strong>{m.movement_type}</strong>
                {m.reason && <> &ndash; {m.reason}</>}
                <span className="muted block">{m.moved_on}{m.created_by && <> &middot; {m.created_by}</>}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button type="button" className="btn secondary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
