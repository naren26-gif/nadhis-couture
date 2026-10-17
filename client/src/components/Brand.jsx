import { useState } from 'react';

// Shows the logo if client/public/logo.png exists, otherwise a text wordmark.
export default function Brand() {
  const [hasLogo, setHasLogo] = useState(true);
  return hasLogo ? (
    <img src="/logo.png" alt="Nadhi's Couture" onError={() => setHasLogo(false)} />
  ) : (
    <span>Nadhi's Couture</span>
  );
}
