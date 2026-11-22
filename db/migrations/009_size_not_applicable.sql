-- =====================================================================
-- Migration 009: a "N/A" size, for products that have no size (for example fabric sold as a cut piece)
--
-- Every product variant must have a size. Fabric has none, so fabric variants use the size "N/A".
-- Data only: one row in size_ref, put at the end of the size list. No table is changed, and stock is still counted
-- in whole pieces. Safe to re-run (it does nothing if "N/A" already exists).
--
-- Apply to DEV first, as the admin (postgres) user. One transaction: if anything fails, nothing is applied.
--   psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -1 -f db/migrations/009_size_not_applicable.sql
-- Re-running db/supabase_hardening.sql is not needed (no schema change), but it is safe to do so.
-- =====================================================================

INSERT INTO size_ref (code, sort_order)
SELECT 'N/A', COALESCE(MAX(sort_order), 0) + 1
  FROM size_ref
HAVING NOT EXISTS (SELECT 1 FROM size_ref WHERE lower(code) = 'n/a');
