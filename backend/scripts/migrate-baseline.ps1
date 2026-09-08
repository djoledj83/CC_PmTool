# One-time cutover from `prisma db push` to `prisma migrate`.
# Run from the backend/ directory on a machine whose backend/.env
# DATABASE_URL points at the database you want to baseline.
#
#   cd backend
#   .\scripts\migrate-baseline.ps1
#
# What it does (see docs/migrations.md for the full rationale):
#   1. Generates a single "init" migration containing the SQL for the
#      ENTIRE current schema (read from schema.prisma, not the DB —
#      no data is touched).
#   2. Marks that migration as already applied on the target DB, so
#      `migrate deploy` on next boot is a clean no-op.
#
# After this, every schema change goes through:
#   npm run db:migrate:dev -- --name describe_the_change
# and gets committed together with schema.prisma.

$ErrorActionPreference = "Stop"

if (-not (Test-Path "prisma/schema.prisma")) {
    Write-Error "Run this from the backend/ directory (prisma/schema.prisma not found)."
}

# Use the project's own Prisma CLI so the flags match the version the
# backend actually runs (a bare `npx prisma` can resolve to a newer
# major with renamed flags).
$prisma = "node_modules/.bin/prisma.cmd"
if (-not (Test-Path $prisma)) {
    Write-Host "Local Prisma not found - installing project deps first (npm install)..."
    npm install
    if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed" }
}

# Clean up empty *_init dirs left behind by previously failed runs.
Get-ChildItem "prisma/migrations" -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "_init$" } |
    ForEach-Object {
        $sql = Join-Path $_.FullName "migration.sql"
        if (-not (Test-Path $sql) -or (Get-Item $sql).Length -eq 0) {
            Write-Host "Removing leftover empty $($_.Name) from a failed run"
            Remove-Item -Recurse -Force $_.FullName
        }
    }

# Refuse to run twice: a populated init migration means we're done.
$existing = Get-ChildItem "prisma/migrations" -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "_init$" }
if ($existing) {
    Write-Host "Baseline already exists: $($existing.Name). Nothing to do."
    exit 0
}

$stamp = Get-Date -Format "yyyyMMddHHmmss"
$dir = "prisma/migrations/${stamp}_init"
New-Item -ItemType Directory -Path $dir -Force | Out-Null

Write-Host "1/2 Generating baseline SQL -> $dir/migration.sql"
& $prisma migrate diff `
    --from-empty `
    --to-schema-datamodel prisma/schema.prisma `
    --script | Out-File -Encoding utf8 "$dir/migration.sql"
if ($LASTEXITCODE -ne 0) { Write-Error "migrate diff failed" }

Write-Host "2/2 Marking ${stamp}_init as applied on the target database"
& $prisma migrate resolve --applied "${stamp}_init"
if ($LASTEXITCODE -ne 0) { Write-Error "migrate resolve failed" }

Write-Host ""
Write-Host "Done. Verify with: npm run db:migrate:status"
Write-Host "Commit prisma/migrations/ (including migration_lock.toml) to git."
