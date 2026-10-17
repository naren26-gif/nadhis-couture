import { useState } from 'react';
import { NavLink, Outlet, Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import Brand from './Brand.jsx';

export default function Layout() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand" onClick={close}>
            <Brand />
          </Link>
          <button
            className="menu-toggle"
            aria-expanded={open}
            aria-controls="main-nav"
            onClick={() => setOpen((o) => !o)}
          >
            Menu
          </button>
          <nav id="main-nav" className={`nav${open ? ' open' : ''}`}>
            <NavLink to="/" end onClick={close}>Home</NavLink>
            <NavLink to="/products" onClick={close}>Products</NavLink>
            <NavLink to="/inventory" onClick={close}>Inventory</NavLink>
            <NavLink to="/orders" onClick={close}>Orders</NavLink>
            <NavLink to="/shipping" onClick={close}>Shipping</NavLink>
            <NavLink to="/purchases" onClick={close}>Purchases</NavLink>
            <NavLink to="/suppliers" onClick={close}>Suppliers</NavLink>
            <NavLink to="/customers" onClick={close}>Customers</NavLink>
            <NavLink to="/reports" onClick={close}>Reports</NavLink>
            <span className="who">{user.name}</span>
            <button className="linklike" onClick={logout}>Log out</button>
          </nav>
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </>
  );
}
