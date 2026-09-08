# ----------------------------------------------------------------------------
# PM Tool — backup script (PowerShell wrapper for Windows dev hosts)
#
# Mirror of scripts/backup.sh — produces the same two artefacts
# (db_<UTC-timestamp>.sql.gz and uploads_<UTC-timestamp>.tar.gz) using
# the same throwaway Docker containers, so the host doesn't need
# pg_dump / tar installed.
#
# Usage:
#   .\scripts\backup.ps1
#   .\scripts\backup.ps1 -BackupDir D:\backups -RetentionDays 30
#
# Configuration parameters mirror the bash version — see backup.sh for
# the canonical description of each.
# ----------------------------------------------------------------------------

[CmdletBinding()]
param(
    [string]$BackupDir = "./backups",
    [string]$EnvFile = "./backend/.env",
    [string]$DatabaseUrl,
    [string]$UploadsVolume,
    # Docker network used by the pg_dump container. Default: auto-detect
    # the *_app-network created by docker-compose so pg_dump presents the
    # same source IP as the backend (already in pg_hba.conf). Pass
    # "host" to use the host network instead.
    [string]$BackupNetwork,
    [int]$RetentionDays = 14
)

$ErrorActionPreference = 'Stop'

function Log([string]$msg) {
    $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    Write-Host "[$ts] $msg"
}
function Die([string]$msg) {
    Log "ERROR: $msg"
    exit 1
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Die "docker not on PATH"
}

# --- Resolve DATABASE_URL ---------------------------------------------------
if (-not $DatabaseUrl) {
    if (-not (Test-Path $EnvFile)) {
        Die "no DATABASE_URL and $EnvFile not found"
    }
    $line = Select-String -Path $EnvFile -Pattern '^DATABASE_URL=' | Select-Object -First 1
    if (-not $line) { Die "DATABASE_URL line not found in $EnvFile" }
    $DatabaseUrl = $line.Line -replace '^DATABASE_URL=', '' -replace '^"|"$', ''
}

# pg_dump (libpq) rejects Prisma-only query params with
#   "pg_dump: error: invalid URI query parameter: connection_limit"
# Strip them from the URL we pass to pg_dump. DATABASE_URL_DUMP wins
# if explicitly provided (useful for a replica / dump user).
function Strip-PrismaParams([string]$url) {
    foreach ($p in 'connection_limit', 'pool_timeout', 'pgbouncer', 'schema') {
        # 1) first param followed by more: ?name=val& -> ?
        $url = $url -replace "\?${p}=[^&]*&", '?'
        # 2) middle/last after others: &name=val -> (empty)
        $url = $url -replace "&${p}=[^&]*", ''
        # 3) only param: ?name=val$ -> (drop ?)
        $url = $url -replace "\?${p}=[^&]*$", ''
    }
    return $url
}

if ($env:DATABASE_URL_DUMP) {
    $DumpUrl = $env:DATABASE_URL_DUMP
} else {
    $DumpUrl = Strip-PrismaParams $DatabaseUrl
}

# --- Resolve docker network for pg_dump -------------------------------------
$networkFallbackWarn = $null
if (-not $BackupNetwork) {
    $netCandidates = (& docker network ls --format '{{.Name}}') -split "`r?`n" |
        Where-Object { $_ -match '(^|_)app-network$' }
    if ($netCandidates.Count -gt 0) {
        $BackupNetwork = $netCandidates[0]
    } else {
        $networkFallbackWarn = 'no *_app-network docker network found - falling back to --network host'
        $BackupNetwork = 'host'
    }
}

# --- Resolve uploads volume -------------------------------------------------
if (-not $UploadsVolume) {
    $candidates = (& docker volume ls --format '{{.Name}}') -split "`r?`n" |
        Where-Object { $_ -match '(^|_)pm_uploads$' }
    if ($candidates.Count -gt 0) {
        $UploadsVolume = $candidates[0]
    }
}
if (-not $UploadsVolume) {
    Die "could not auto-detect pm_uploads volume; pass -UploadsVolume"
}
& docker volume inspect $UploadsVolume *> $null
if ($LASTEXITCODE -ne 0) { Die "docker volume '$UploadsVolume' does not exist" }

if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir | Out-Null
}
$ts = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$dbOut = Join-Path $BackupDir "db_$ts.sql.gz"
$uplOut = Join-Path $BackupDir "uploads_$ts.tar.gz"
# Resolve to absolute so the Docker bind mount works regardless of CWD
$absBackupDir = (Resolve-Path $BackupDir).Path
$uplOutName = "uploads_$ts.tar.gz"

Log "starting backup -> $BackupDir"
Log "  pg_dump   target: $dbOut"
Log "  pg_dump   network: $BackupNetwork"
if ($networkFallbackWarn) { Log "  warn: $networkFallbackWarn" }
Log "  uploads   volume: $UploadsVolume -> $uplOut"

# --- 1. Postgres dump -------------------------------------------------------
# PowerShell stdout redirect (`>`) preserves byte stream so the gzipped
# pg_dump output reaches the file unchanged. We join the same docker
# network the backend uses so pg_dump presents the source IP already
# whitelisted in pg_hba.conf.
& docker run --rm --network $BackupNetwork `
    -e DB_URL=$DumpUrl `
    postgres:16-alpine `
    sh -c 'pg_dump --no-owner --no-privileges --clean --if-exists "$DB_URL" | gzip -9' `
    > $dbOut
if ($LASTEXITCODE -ne 0) { Die "pg_dump failed" }
$dbSize = (Get-Item $dbOut).Length
if ($dbSize -lt 1024) { Die "pg_dump output suspiciously small ($dbSize bytes) - aborting" }
Log "  pg_dump   wrote $dbSize bytes"

# --- 2. Uploads volume snapshot --------------------------------------------
& docker run --rm `
    -v "${UploadsVolume}:/data:ro" `
    -v "${absBackupDir}:/out" `
    alpine:3.20 `
    sh -c "cd /data && tar czf /out/$uplOutName ."
if ($LASTEXITCODE -ne 0) { Die "uploads tar failed" }
$uplSize = (Get-Item $uplOut).Length
Log "  uploads   wrote $uplSize bytes"

# --- 3. Refresh the "latest" pointers ---------------------------------------
# Overwrite fixed db_latest / uploads_latest filenames with this run's good
# artefacts, so there's always a known-newest backup to grab without hunting
# timestamps. Copies (not moves), so the timestamped history is untouched.
$dbLatest = Join-Path $BackupDir 'db_latest.sql.gz'
$uplLatest = Join-Path $BackupDir 'uploads_latest.tar.gz'
Copy-Item -Path $dbOut -Destination $dbLatest -Force
Copy-Item -Path $uplOut -Destination $uplLatest -Force
Log "  latest    refreshed db_latest.sql.gz + uploads_latest.tar.gz"

# --- 4. Retention -----------------------------------------------------------
# Prune only timestamped history; never the *_latest.* pointers.
if ($RetentionDays -gt 0) {
    $cutoff = (Get-Date).AddDays(-$RetentionDays)
    $purged = Get-ChildItem -Path $BackupDir -File |
        Where-Object {
            ($_.Name -like 'db_*.sql.gz' -or $_.Name -like 'uploads_*.tar.gz') -and
            $_.Name -notlike '*_latest.*' -and
            $_.LastWriteTime -lt $cutoff
        }
    foreach ($f in $purged) { Remove-Item $f.FullName -Force }
    Log "  retention pruned $($purged.Count) file(s) older than ${RetentionDays}d"
}

Log "backup OK"
