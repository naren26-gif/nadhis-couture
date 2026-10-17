import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

// Loads the dropdown lists (products, fabrics, sizes, colours, suppliers) and can add new values to them.
export function useLookups() {
  const [lookups, setLookups] = useState(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setLookups(await api('/lookups'));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // kind: 'fabrics' | 'sizes' | 'colours'. Returns the saved value.
  const addValue = useCallback(
    async (kind, name) => {
      const saved = await api(`/lookups/${kind}`, { method: 'POST', body: { name } });
      await refresh();
      return saved.name;
    },
    [refresh],
  );

  // Returns the new product's id.
  const addProduct = useCallback(
    async (name) => {
      const saved = await api('/products', { method: 'POST', body: { name } });
      await refresh();
      return saved.id;
    },
    [refresh],
  );

  return { lookups, error, refresh, addValue, addProduct };
}
