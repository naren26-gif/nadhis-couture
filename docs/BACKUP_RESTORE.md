# Backup and restore

Two layers of protection:
1. **Supabase backups** (dashboard > Database > Backups): daily on the Pro plan. Point-in-Time Recovery is an optional extra.
2. **Our own dump** (`scripts/backup.ps1`): a portable copy you control, usable on any PostgreSQL (Supabase now, AWS RDS later).

## Take a backup (you, in PowerShell; production secrets stay in this window only)
```powershell
$env:ADMIN_DB_URL = '<production Session pooler string>'
.\scripts\backup.ps1
Remove-Item Env:ADMIN_DB_URL
```
Files go to `~\nadhi-backups` (outside the project, never committed); the newest 14 are kept. Do this before any risky
step (cutover, a migration) and then weekly. Off-site copies (S3) come with the AWS deployment.

## Restore (always into a NEW, EMPTY database, never over production)
1. Create a new Supabase project (free tier is fine for a practice), copy its Session pooler string.
2. ```powershell
   $env:SCRATCH_DB_URL = '<scratch project admin string>'
   pg_restore --no-owner --no-privileges -d $env:SCRATCH_DB_URL "$HOME\nadhi-backups\prod_<date>.dump"
   psql $env:SCRATCH_DB_URL -f db/verify_production.sql
   ```
   One message, `schema "public" already exists`, is normal and harmless (every Supabase project has that schema). Any other error is real.
3. Compare the counts with the expected numbers at the top of `db/verify_production.sql`. The lock checks (RLS, API roles)
   will differ on a scratch copy; run `db/supabase_hardening.sql` if the copy is going to be used for real.
4. Delete the scratch project when the practice is done.

If production is ever lost, the same restore into a fresh project, plus `supabase_hardening.sql`, is the recovery.
