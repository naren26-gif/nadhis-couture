# Production load runbook (Phase 2 finish)

You run these in your own PowerShell, from the project root. Claude never sees the production connection string or
passwords. Paste back only the non-secret output (row counts, the report tables, error text without passwords).

Use a NEW empty Supabase production project (keep the old one untouched until everything below is verified).
In the new project: Settings > Data API > turn it OFF.

## Why the order is different from the README
Migrations 001-003 grant rights to `app_backend`, and that role is only created by `supabase_hardening.sql`. So the role is
created first (hardening on the empty schema), the data is loaded the same way as on dev (load, then migrations 001-005),
and hardening is run once more at the end so it covers the new tables and sequences.

## Steps
```powershell
# 0. production settings for THIS window only (do not put them in .env or any file in this folder)
$env:ADMIN_DB_URL    = "<production Session pooler string, admin password filled in>"
$env:APP_DB_PASSWORD = "<NEW strong password for the production app role, different from dev>"

# 1. schema on the empty database
psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -1 -f db/schema.sql

# 2. create the app_backend role (hardening on the empty schema)
psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -v app_password="$env:APP_DB_PASSWORD" -f db/supabase_hardening.sql

# 3. load the workbook (one transaction, rolls back if any check fails)
python migration/migrate.py --xlsx "Nadhis_Couture_Database_Migration_Review.xlsx" --load --dsn $env:ADMIN_DB_URL

# 4. migrations, in order
psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -1 -f db/migrations/001_app_user_and_sessions.sql
psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -1 -f db/migrations/002_party_code_sequences.sql
psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -1 -f db/migrations/003_purchase_codes_and_receipt_guard.sql
psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -1 -f db/migrations/004_customer_refunds.sql
psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -1 -f db/migrations/005_gapless_shipment_codes.sql

# 5. harden again so it covers everything the migrations added
psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -v app_password="$env:APP_DB_PASSWORD" -f db/supabase_hardening.sql

# 6. read-only checks (paste the output back to Claude)
psql $env:ADMIN_DB_URL -f db/verify_production.sql

# 7. clear the secrets from this window
Remove-Item Env:ADMIN_DB_URL, Env:APP_DB_PASSWORD
```

## What good looks like
Suppliers 4, customers 3, variants 55, purchase orders 6, orders 4, shipments 3, payments 11, total stock 51, no negative
stock, purchases paid 25,312.00 of 25,312.00, courier owed 250.00, `app_user` 0 rows, every migration-object row `true`,
and the three "want no rows" checks empty.

Do not create the production login (`npm run create-user`) or point `.env` at production yet; that is cutover.
