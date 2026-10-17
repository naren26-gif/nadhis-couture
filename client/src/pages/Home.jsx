import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

const SOON = ['Shipping', 'Courier month-end', 'Reports'];

export default function Home() {
  const { user } = useAuth();
  return (
    <>
      <h1>Welcome, {user.name}</h1>
      <p className="muted">Your shop, in one place.</p>
      <div className="tiles">
        <Link className="tile" to="/products">
          <strong>Products</strong>
          <span className="muted">Add and edit products, sizes, colours and prices</span>
        </Link>
        <Link className="tile" to="/inventory">
          <strong>Inventory</strong>
          <span className="muted">See stock on hand and correct it with a reason</span>
        </Link>
        <Link className="tile" to="/orders">
          <strong>Orders</strong>
          <span className="muted">Take customer orders and record payments</span>
        </Link>
        <Link className="tile" to="/purchases">
          <strong>Purchases</strong>
          <span className="muted">Buy stock, receive it, and pay your suppliers</span>
        </Link>
        <Link className="tile" to="/suppliers">
          <strong>Suppliers</strong>
          <span className="muted">Who you buy from, with phone numbers</span>
        </Link>
        <Link className="tile" to="/customers">
          <strong>Customers</strong>
          <span className="muted">Who you sell to, with phone numbers</span>
        </Link>
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
