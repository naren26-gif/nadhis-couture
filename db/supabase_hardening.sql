-- =====================================================================
-- Nadhi's Couture - Supabase hardening (run ONCE after schema.sql + data load; safe to re-run)
--
-- Why: Supabase auto-generates a public web API (the "Data API") over the `public` schema, and its default
-- roles (anon, authenticated, service_role) can be granted access to new tables. This app never uses that API
-- (only our own backend talks to the database), so we shut every door that is not ours:
--   1. a dedicated, limited login role `app_backend` for our backend (never use `postgres` in the app)
--   2. take all access away from the API roles
--   3. enable Row Level Security on every table (a second lock, in case a grant ever reappears)
--
-- Run as the `postgres` user:
--   psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=1 -v app_password="$APP_DB_PASSWORD" -f db/supabase_hardening.sql
-- Re-run it after adding any new table, view or function.
-- =====================================================================

-- 1. application login role (created if missing; password set/updated every run)
SELECT format('CREATE ROLE app_backend LOGIN PASSWORD %L', :'app_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_backend') \gexec
SELECT format('ALTER ROLE app_backend WITH LOGIN PASSWORD %L', :'app_password') \gexec
ALTER ROLE app_backend SET search_path = public;
ALTER ROLE app_backend SET statement_timeout = '30s';   -- a runaway query cannot hang the database

-- 2. API roles get nothing, now and for future objects
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;   -- functions are executable by everyone unless revoked

-- 3. least privilege for the backend: read, insert, update. NO delete, NO truncate, NO schema changes.
--    (Grant DELETE on a specific table later, only when a feature really needs it.)
GRANT USAGE ON SCHEMA public TO app_backend;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_backend;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_backend;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_backend;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO app_backend;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_backend;
REVOKE UPDATE ON inventory_movement FROM app_backend;       -- stock history is append-only (also blocked by a trigger)

-- 4. Row Level Security on every table: only app_backend gets a policy. The owner (postgres, used for
--    migrations/admin) bypasses RLS as usual. Views run with the caller's rights so RLS still applies.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('DROP POLICY IF EXISTS app_backend_all ON public.%I', t.tablename);
    EXECUTE format('CREATE POLICY app_backend_all ON public.%I FOR ALL TO app_backend USING (true) WITH CHECK (true)', t.tablename);
  END LOOP;
  FOR t IN SELECT viewname FROM pg_views WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', t.viewname);
  END LOOP;
END $$;

-- 5. Report (read it: every table should show RLS = true, and the API roles line should return no rows)
\echo
\echo '--- tables with Row Level Security (want: all of them) ---'
SELECT count(*) FILTER (WHERE rowsecurity) AS tables_with_rls, count(*) AS total_tables
  FROM pg_tables WHERE schemaname = 'public';
\echo '--- table privileges still held by API roles (want: no rows) ---'
SELECT grantee, count(*) AS grants FROM information_schema.role_table_grants
 WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'service_role') GROUP BY grantee;
