-- =====================================================================
-- Migration 002: sequences for the next supplier / customer business code
-- (SPLR0001 style and CUST0001 style). Adds two NEW sequences only; no existing row changes.
-- Each sequence starts after the highest number already used, so existing codes are never renumbered or reused.
-- A rolled-back insert can leave a gap in the numbers; that is fine.
-- Apply to DEV first, as the admin (postgres) user:
--   psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -1 -f db/migrations/002_party_code_sequences.sql
-- Then re-run db/supabase_hardening.sql (safe to re-run).
-- =====================================================================

CREATE SEQUENCE supplier_code_seq;
CREATE SEQUENCE customer_code_seq;

SELECT setval('supplier_code_seq',
  COALESCE((SELECT MAX(substring(supplier_code from '[0-9]+$')::bigint)
              FROM supplier WHERE supplier_code ~ '^SPLR[0-9]+$'), 0) + 1,
  false);
SELECT setval('customer_code_seq',
  COALESCE((SELECT MAX(substring(customer_code from '[0-9]+$')::bigint)
              FROM customer WHERE customer_code ~ '^CUST[0-9]+$'), 0) + 1,
  false);

GRANT USAGE, SELECT ON supplier_code_seq, customer_code_seq TO app_backend;
