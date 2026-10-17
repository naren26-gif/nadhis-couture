import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Home from './pages/Home.jsx';
import Inventory from './pages/Inventory.jsx';
import OrderDetail from './pages/OrderDetail.jsx';
import OrderFormPage from './pages/OrderFormPage.jsx';
import Orders from './pages/Orders.jsx';
import Parties from './pages/Parties.jsx';
import PartyFormPage from './pages/PartyFormPage.jsx';
import Products from './pages/Products.jsx';
import ShipmentDetail from './pages/ShipmentDetail.jsx';
import Shipping from './pages/Shipping.jsx';
import PurchaseDetail from './pages/PurchaseDetail.jsx';
import PurchaseFormPage from './pages/PurchaseFormPage.jsx';
import Purchases from './pages/Purchases.jsx';
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
        <Route path="/orders" element={<Orders />} />
        <Route path="/orders/new" element={<OrderFormPage />} />
        <Route path="/orders/:id" element={<OrderDetail />} />
        <Route path="/orders/:id/edit" element={<OrderFormPage />} />
        <Route path="/purchases" element={<Purchases />} />
        <Route path="/purchases/new" element={<PurchaseFormPage />} />
        <Route path="/purchases/:id" element={<PurchaseDetail />} />
        <Route path="/purchases/:id/edit" element={<PurchaseFormPage />} />
        <Route path="/shipping" element={<Shipping />} />
        <Route path="/shipments/:id" element={<ShipmentDetail />} />
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
