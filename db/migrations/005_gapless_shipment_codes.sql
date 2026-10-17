-- =====================================================================
-- Migration 005: gapless shipment codes (SH_0000001 style)
--
-- Until now the code came from a counter (shipment_code_seq). A counter never gives a number back, so every
-- rolled-back shipment attempt (and every test run) skipped a number. The owner wants "last code + 1, no gaps",
-- like every other code in the app.
--
-- What changes
--   * A BEFORE INSERT trigger on shipment sets the code to 'SH_' + 7 digits = highest existing code + 1, under an
--     advisory lock so two parcels created at the same moment cannot get the same number.
--   * The column DEFAULT (the counter) is dropped. The ship_* functions are NOT touched: they never name the code.
-- No existing row changes. A code given explicitly (as the original data load did) is still respected.
--
-- Apply to DEV first, as the admin (postgres) user. One transaction: if anything fails, nothing is applied.
--   psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -1 -f db/migrations/005_gapless_shipment_codes.sql
-- Then re-run db/supabase_hardening.sql (safe to re-run).
-- =====================================================================

CREATE FUNCTION set_shipment_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('code:shipment', 0));   -- one parcel at a time gets a number
  SELECT 'SH_' || lpad((COALESCE(MAX(substring(shipment_code from '[0-9]+$')::bigint), 0) + 1)::text, 7, '0')
    INTO NEW.shipment_code
    FROM shipment
   WHERE shipment_code ~ '^SH_[0-9]{7}$';
  RETURN NEW;
END $$;

CREATE TRIGGER trg_shipment_code BEFORE INSERT ON shipment
  FOR EACH ROW WHEN (NEW.shipment_code IS NULL) EXECUTE FUNCTION set_shipment_code();

ALTER TABLE shipment ALTER COLUMN shipment_code DROP DEFAULT;
