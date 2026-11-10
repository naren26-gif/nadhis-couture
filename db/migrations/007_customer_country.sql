-- =====================================================================
-- Migration 007: customer country (so the shop can ship outside India)
--
-- Decision (owner): the delivery address gets a Country. India stays the default and keeps its rules (state from the
-- list, 6-digit PIN code). For any other country the state/region is free text and the postal code is 3-10 letters,
-- digits, spaces or hyphens. Prices, payments and shipping charges stay INR-only for now (no multi-currency).
--
-- What changes
--   1. customer.country (required, default 'India', so every existing customer becomes India).
--   2. The PIN-code check from 006 is replaced by one that depends on the country.
--   3. Phone uniqueness no longer looks at only the last 10 digits (that is an Indian-number idea and could clash
--      two numbers from different countries). phone_key() turns a number into one canonical form:
--        digits only, a leading 00 removed; a 10-digit number, or 0 + 10 digits, is an Indian number and gets 91 in
--        front; anything else is kept in full (it already carries its country code).
--      So "98765 43210", "098765 43210", "+91 98765-43210" are one number, and "+44 98765 43210" is a different one.
--      A 10-digit number typed WITHOUT a country code is always taken as Indian.
--      (customer_phone_digits_uq from 006 is replaced by customer_phone_key_uq.)
-- No existing row's data changes except the new column getting 'India'.
--
-- Apply to DEV first, as the admin (postgres) user. One transaction: if anything fails, nothing is applied.
--   psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -1 -f db/migrations/007_customer_country.sql
-- Then re-run db/supabase_hardening.sql (safe to re-run; it lets the app role use the new function).
-- =====================================================================

ALTER TABLE customer ADD COLUMN country text NOT NULL DEFAULT 'India' CHECK (country = btrim(country) AND country <> '');

ALTER TABLE customer DROP CONSTRAINT customer_pincode_check;
ALTER TABLE customer ADD CONSTRAINT customer_pincode_check CHECK (
  pincode IS NULL
  OR (country = 'India' AND pincode ~ '^[0-9]{6}$')
  OR (country <> 'India' AND pincode ~ '^[A-Za-z0-9][A-Za-z0-9 -]{1,8}[A-Za-z0-9]$')
);

CREATE FUNCTION phone_key(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN d = '' THEN ''
           WHEN length(d) = 10 THEN '91' || d
           WHEN length(d) = 11 AND left(d, 1) = '0' THEN '91' || substr(d, 2)
           ELSE d
         END
    FROM (SELECT regexp_replace(regexp_replace(COALESCE(p, ''), '\D', '', 'g'), '^00', '') AS d) x
$$;

DROP INDEX customer_phone_digits_uq;
CREATE UNIQUE INDEX customer_phone_key_uq ON customer (phone_key(phone))
  WHERE phone IS NOT NULL AND phone_key(phone) <> '';
