import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Home from './pages/Home.jsx';
import Inventory from './pages/Inventory.jsx';
import Parties from './pages/Parties.jsx';
import PartyFormPage from './pages/PartyFormPage.jsx';
import Products from './pages/Products.jsx';
import VariantFormPage from './pages/VariantFormPage.jsx';

function RequireLogin({ children }) {
  const { user, checking } = useAuth();
  if (checking) return <div className="loading">Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireLogin>
            <Layout />
          </RequireLogin>
        }
      >
        <Route path="/" element={<Home />} />
        <Route path="/products" element={<Products />} />
        <Route path="/products/new" element={<VariantFormPage />} />
        <Route path="/products/:id/edit" element={<VariantFormPage />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/suppliers" element={<Parties kind="supplier" />} />
        <Route path="/suppliers/new" element={<PartyFormPage kind="supplier" />} />
        <Route path="/suppliers/:id/edit" element={<PartyFormPage kind="supplier" />} />
        <Route path="/customers" element={<Parties kind="customer" />} />
        <Route path="/customers/new" element={<PartyFormPage kind="customer" />} />
        <Route path="/customers/:id/edit" element={<PartyFormPage kind="customer" />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
