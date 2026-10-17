import { useState } from 'react';
import Modal from './Modal.jsx';

// Pop-up to add one new value (a product name, fabric, size or colour). onSave(name) throws a friendly Error on problems.
export default function AddValueDialog({ title, label, placeholder, onSave, onClose }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    // This pop-up sits inside the variant form; without this, React also fires that form's Save.
    e.stopPropagation();
    setError('');
    setBusy(true);
    try {
      await onSave(name);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        {error && <div className="alert error" role="alert">{error}</div>}
        <div className="field">
          <label htmlFor="new-value">{label}</label>
          <input id="new-value" type="text" value={name} placeholder={placeholder} onChange={(e) => setName(e.target.value)} autoFocus required />
        </div>
        <div className="actions">
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving...' : 'Add'}</button>
        </div>
      </form>
    </Modal>
  );
}
