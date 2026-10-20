# Nadhi's Couture - back up the PRODUCTION database to a dated file (read-only on the database).
# Run from any PowerShell window after setting the admin connection string for this window only:
#   $env:ADMIN_DB_URL = '<production Session pooler string>'
#   .\scripts\backup.ps1
#   Remove-Item Env:ADMIN_DB_URL
# The dump holds customer data: it goes to a folder OUTSIDE the project and is never committed.
param(
  [string]$Folder = (Join-Path $HOME 'nadhi-backups'),
  [int]$Keep = 14
)
$ErrorActionPreference = 'Stop'
if (-not $env:ADMIN_DB_URL) { throw 'Set $env:ADMIN_DB_URL first (production Session pooler string).' }

New-Item -ItemType Directory -Force -Path $Folder | Out-Null
$file = Join-Path $Folder ("prod_{0}.dump" -f (Get-Date -Format 'yyyy-MM-dd_HHmm'))

pg_dump $env:ADMIN_DB_URL --schema=public --no-owner --no-privileges -Fc -f $file
if ($LASTEXITCODE -ne 0) { Remove-Item $file -ErrorAction SilentlyContinue; throw 'pg_dump failed - no backup was made.' }

# prove the file is a readable dump: count its table entries
$tables = (pg_restore --list $file | Select-String ' TABLE ' | Measure-Object).Count
$kb = [math]::Round((Get-Item $file).Length / 1KB)
Write-Host "Backup written: $file ($kb KB, $tables table entries)"

# keep only the newest $Keep dumps
Get-ChildItem $Folder -Filter 'prod_*.dump' | Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep | Remove-Item
