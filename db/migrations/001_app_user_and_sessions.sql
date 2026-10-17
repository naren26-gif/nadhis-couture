-- =====================================================================
-- Migration 001: app users (login) and login sessions
-- Adds two NEW tables only. Nothing existing is changed.
-- Apply to DEV first, as the admin (postgres) user:
--   psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -1 -f db/migrations/001_app_user_and_sessions.sql
-- Then re-run db/supabase_hardening.sql (safe to re-run) so Row Level Security covers the new tables.
-- =====================================================================

CREATE TABLE app_user (
  user_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
  display_name  text NOT NULL CHECK (display_name = btrim(display_name) AND display_name <> ''),
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner', 'staff')),
  is_active     boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_user_email_uq ON app_user (email);
CREATE TRIGGER app_user_updated_at BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Login sessions (the layout the connect-pg-simple library expects)
CREATE TABLE app_session (
  sid    varchar      NOT NULL PRIMARY KEY,
  sess   json         NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX app_session_expire_ix ON app_session (expire);

-- The app role may read/insert/update (see hardening script). Expired sessions must be purged and
-- logout must remove the session, so this ONE table also gets DELETE. No other table does.
GRANT SELECT, INSERT, UPDATE, DELETE ON app_session TO app_backend;
GRANT SELECT, INSERT, UPDATE ON app_user TO app_backend;
