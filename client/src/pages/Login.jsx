import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import Brand from '../components/Brand.jsx';

export default function Login() {
  const { user, checking, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!checking && user) return <Navigate to="/" replace />;

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-col">
      <div className="login-brand">
        <Brand className="logo-large" />
      </div>
      <form className="card login-card" onSubmit={submit}>
        <h2>Welcome back</h2>
        <p className="muted">Please log in to continue.</p>
        {error && <div className="alert error" role="alert">{error}</div>}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <button className="btn full" type="submit" disabled={busy}>{busy ? 'Logging in...' : 'Log in'}</button>
      </form>
      </div>
    </div>
  );
}
