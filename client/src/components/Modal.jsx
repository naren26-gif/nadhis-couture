import { useEffect } from 'react';
import { createPortal } from 'react-dom';

// A simple pop-up. Closes with the Escape key or by clicking the dimmed background.
export default function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // the page behind a pop-up should not scroll while it is open (several pop-ups can be open at once: restore the previous state)
  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = before;
    };
  }, []);

  // Drawn directly in <body> so a pop-up opened from inside a form is not a form nested in a form.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
