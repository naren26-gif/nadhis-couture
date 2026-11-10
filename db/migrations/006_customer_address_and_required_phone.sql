-- =====================================================================
-- Migration 006: one saved delivery address per customer; phone + address required for NEW customers
--
-- Decision (owner): every new customer needs a phone number (their unique identity) and a delivery address. One address
-- per customer, stored on the customer row. Existing customers are NOT changed and keep working even without them.
--
-- What changes
--   1. customer gets address_line1, address_line2, city, state, pincode (all nullable, so old rows stay valid).
--      The old free-text `location` column stays.
--   2. pincode must be 6 digits when present.
--   3. When the APP (role app_backend) inserts a customer, phone, address_line1, city, state and pincode must be filled.
--      Loads/restores run as the admin role and are not affected (the Excel migration inserts customers without them).
--      Editing is not blocked here, so hiding/showing an old customer still works; the API asks for the missing
--      details when an old customer is edited.
--   4. A phone number can belong to one customer only, however it is written: the last 10 digits are compared, so
--      "98765 43210", "+91 98765-43210" and "098765 43210" are the same number. (The old exact-text unique index stays.)
--      Checked on DEV before writing this: no existing customers collide.
--
-- Apply to DEV first, as the admin (postgres) user. One transaction: if anything fails, nothing is applied.
--   psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -1 -f db/migrations/006_customer_address_and_required_phone.sql
-- Then re-run db/supabase_hardening.sql (safe to re-run).
-- =====================================================================

ALTER TABLE customer
  ADD COLUMN address_line1 text,
  ADD COLUMN address_line2 text,
  ADD COLUMN city          text,
  ADD COLUMN state         text,
  ADD COLUMN pincode       text;

ALTER TABLE customer ADD CONSTRAINT customer_pincode_check
  CHECK (pincode IS NULL OR pincode ~ '^[0-9]{6}$');

CREATE FUNCTION require_customer_contact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'app_backend' THEN
    IF NEW.phone IS NULL OR btrim(NEW.phone) = '' THEN
      RAISE EXCEPTION 'A customer needs a phone number' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.address_line1 IS NULL OR btrim(NEW.address_line1) = ''
       OR NEW.city IS NULL OR btrim(NEW.city) = ''
       OR NEW.state IS NULL OR btrim(NEW.state) = ''
       OR NEW.pincode IS NULL THEN
      RAISE EXCEPTION 'A customer needs a delivery address (line 1, city, state and PIN code)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_customer_require_contact BEFORE INSERT ON customer
  FOR EACH ROW EXECUTE FUNCTION require_customer_contact();

CREATE UNIQUE INDEX customer_phone_digits_uq
  ON customer ((right(regexp_replace(phone, '\D', '', 'g'), 10)))
  WHERE phone IS NOT NULL AND regexp_replace(phone, '\D', '', 'g') <> '';
