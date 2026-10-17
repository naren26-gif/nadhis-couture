import { useAuth } from '../auth.jsx';

const SOON = ['Inventory', 'Suppliers & customers', 'Purchases', 'Orders', 'Shipping', 'Courier month-end', 'Reports'];

export default function Home() {
  const { user } = useAuth();
  return (
    <>
      <h1>Welcome, {user.name}</h1>
      <p className="muted">Your shop, in one place.</p>
      <div className="tiles">
        {SOON.map((name) => (
          <div className="tile soon" key={name}>
            <strong>{name}</strong>
            <span className="muted">Coming soon</span>
          </div>
        ))}
      </div>
    </>
  );
}
