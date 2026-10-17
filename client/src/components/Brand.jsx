import { useState } from 'react';

// Shows the logo if client/public/logo.png exists, otherwise a text wordmark.
export default function Brand({ className = '' }) {
  const [hasLogo, setHasLogo] = useState(true);
  return hasLogo ? (
    <img className={`logo ${className}`} src="/logo.png" alt="Nadhi's Couture" onError={() => setHasLogo(false)} />
  ) : (
    <span className="wordmark">Nadhi's Couture</span>
  );
}
