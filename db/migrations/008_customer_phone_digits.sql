-- =====================================================================
-- Migration 008: a customer's phone number must have the right number of digits
--
-- Problem: the only phone rule was "6 to 20 characters", so a customer was saved with an 8-digit number.
-- Rule (owner): a phone number has 10 digits.
--   * India (the default country): exactly 10 digits. "+91" or a leading 0 in front is fine.
--   * Other countries: start with + (or 00) and the country code; 8 to 15 digits in total.
--
-- What changes
--   1. phone_key() no longer puts 91 in front of a number that starts with + or 00 (it already carries its country
--      code; a 10-digit "+65 8123 4567" is Singapore, not India). The unique index is rebuilt.
--   2. require_customer_contact() (the insert trigger from 006, app role only) now also checks the digits.
-- Existing rows are NOT changed or blocked: a customer who already has a bad number (the app will refuse to save any
-- edit of that customer until the number is fixed) can still be hidden/shown. The app checks the same rules on edit.
--
-- Apply to DEV first, as the admin (postgres) user. One transaction: if anything fails, nothing is applied.
--   psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -1 -f db/migrations/008_customer_phone_digits.sql
-- Then re-run db/supabase_hardening.sql (safe to re-run).
-- =====================================================================

CREATE OR REPLACE FUNCTION phone_key(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN d = '' THEN ''
           WHEN COALESCE(p, '') ~ '^\s*(\+|00)' THEN d                       -- already has its country code
           WHEN length(d) = 10 THEN '91' || d
           WHEN length(d) = 11 AND left(d, 1) = '0' THEN '91' || substr(d, 2)
           ELSE d
         END
    FROM (SELECT regexp_replace(regexp_replace(COALESCE(p, ''), '\D', '', 'g'), '^00', '') AS d) x
$$;
REINDEX INDEX customer_phone_key_uq;

CREATE OR REPLACE FUNCTION require_customer_contact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  IF current_user = 'app_backend' THEN
    IF NEW.phone IS NULL OR btrim(NEW.phone) = '' THEN
      RAISE EXCEPTION 'A customer needs a phone number' USING ERRCODE = 'check_violation';
    END IF;
    k := phone_key(NEW.phone);
    IF NEW.country = 'India' THEN
      IF k !~ '^91[0-9]{10}$' THEN
        RAISE EXCEPTION 'An Indian phone number must have 10 digits' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW.phone !~ '^\s*(\+|00)' OR length(k) NOT BETWEEN 8 AND 15 THEN
      RAISE EXCEPTION 'A phone number outside India needs the country code and 8 to 15 digits' USING ERRCODE = 'check_violation';
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
