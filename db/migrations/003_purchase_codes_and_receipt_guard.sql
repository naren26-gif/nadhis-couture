-- =====================================================================
-- Migration 003: purchase order / payment code sequences + a guard on received quantity
-- Additive only. No existing row changes.
--   1. po_code_seq          -> next PO_0000006 style code (PO_ + 7 digits)
--   2. transaction_code_seq -> next TRAN_00000010 style code (TRAN_ + 8 digits; TRAN_MIG_* codes are ignored)
--   3. A line can never have received more than was ordered (qty_received <= qty_ordered).
--      Existing rows already satisfy this; if any did not, the whole migration is refused (run with -1).
-- Apply to DEV first, as the admin (postgres) user:
--   psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -1 -f db/migrations/003_purchase_codes_and_receipt_guard.sql
-- Then re-run db/supabase_hardening.sql (safe to re-run).
-- =====================================================================

CREATE SEQUENCE po_code_seq;
CREATE SEQUENCE transaction_code_seq;

SELECT setval('po_code_seq',
  COALESCE((SELECT MAX(substring(po_code from '[0-9]+$')::bigint)
              FROM purchase_order WHERE po_code ~ '^PO_[0-9]+$'), 0) + 1,
  false);
SELECT setval('transaction_code_seq',
  COALESCE((SELECT MAX(substring(transaction_code from '[0-9]+$')::bigint)
              FROM payment_transaction WHERE transaction_code ~ '^TRAN_[0-9]+$'), 0) + 1,
  false);

GRANT USAGE, SELECT ON po_code_seq, transaction_code_seq TO app_backend;

ALTER TABLE purchase_order_item
  ADD CONSTRAINT qty_received_within_ordered CHECK (qty_received <= qty_ordered);
