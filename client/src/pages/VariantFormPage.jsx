import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useLookups } from '../useLookups.js';
import VariantForm from '../components/VariantForm.jsx';

// "Add variant" (/products/new) and "Edit variant" (/products/:id/edit)
export default function VariantFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const { lookups, error: lookupError, addValue, addProduct } = useLookups();
  const [variant, setVariant] = useState(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!editing) return;
    api(`/variants/${id}`)
      .then((data) => setVariant(data.variant))
      .catch((err) => setLoadError(err.message));
  }, [editing, id]);

  const goBack = () => navigate('/products');
  const error = lookupError || loadError;
  const ready = lookups && (!editing || variant);

  return (
    <>
      <p><Link to="/products">&larr; Back to products</Link></p>
      <h1>{editing ? 'Edit variant' : 'Add a product variant'}</h1>
      {error && <div className="alert error" role="alert">{error}</div>}
      {!ready && !error && <div className="loading">Loading...</div>}
      {ready && (
        <VariantForm
          variant={variant || undefined}
          lookups={lookups}
          addValue={addValue}
          addProduct={addProduct}
          onCancel={goBack}
          onSaved={(saved) => navigate('/products', { state: { flash: `Saved ${saved.sku}.` } })}
        />
      )}
    </>
  );
}
