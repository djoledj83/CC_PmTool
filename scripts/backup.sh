#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# PM Tool — nightly backup script
#
# Produces TWO timestamped artefacts under $BACKUP_DIR (default ./backups):
#
#   db_<UTC-timestamp>.sql.gz       — full pg_dump of the configured Postgres
#                                     instance, gzipped. Restore with
#                                     `gunzip -c FILE | psql "$DATABASE_URL"`.
#   uploads_<UTC-timestamp>.tar.gz  — tar.gz of the pm_uploads Docker volume
#                                     contents (avatars, project files,
#                                     chat attachments, app logos).
#
# Both jobs run in throwaway Docker containers, so the host does NOT need
# `pg_dump` or `tar` installed locally — just Docker + Docker Compose.
#
# Designed to be safe under cron: idempotent, prints a 1-line summary on
# success, exits non-zero on ANY step failure so you can wire it to
# whatever alerting you use (e.g. healthchecks.io).
#
# Configuration (env vars, all optional except DATABASE_URL if not in .env):
#   BACKUP_DIR        target directory       (default ./backups)
#   ENV_FILE          path to backend/.env   (default ./backend/.env)
#   DATABASE_URL      Postgres URL           (default: parsed from ENV_FILE)
#   UPLOADS_VOLUME    docker volume name     (default: auto-detected, looks
#                                            for any volume ending in
#                                            "_pm_uploads"; falls back to
#                                            "pm_uploads")
#   RETENTION_DAYS    delete backups older
#                     than this many days    (default 14; set to 0 to keep
#                                             everything)
#
# Cron example (daily at 02:30 UTC, log to /var/log/pm-backup.log):
#   30 2 * * *  cd /opt/pm-tool && /opt/pm-tool/scripts/backup.sh >> /var/log/pm-backup.log 2>&1
# ----------------------------------------------------------------------------

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
ENV_FILE="${ENV_FILE:-./backend/.env}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

# log() prints to the console AND (once BACKUP_DIR exists) mirrors every
# line into two files: backup.log (append-only history) and
# backup-latest.log (truncated at the start of each run, so it always holds
# JUST the most recent run — the "overwrite each time" log you can tail).
log() {
  local line
  line="$(printf '[%s] %s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*")"
  printf '%s\n' "$line"
  [ -n "${RUN_LOG:-}" ] && printf '%s\n' "$line" >>"$RUN_LOG" 2>/dev/null || true
  [ -n "${LATEST_LOG:-}" ] && printf '%s\n' "$line" >>"$LATEST_LOG" 2>/dev/null || true
}
die() { log "ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not on PATH"

# --- Resolve DATABASE_URL ---------------------------------------------------
if [ -z "${DATABASE_URL:-}" ]; then
  [ -f "$ENV_FILE" ] || die "no DATABASE_URL and $ENV_FILE not found"
  # Parse a single DATABASE_URL=... line from .env. We strip surrounding
  # quotes if any so the URL is forwarded verbatim to pg_dump.
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
  [ -n "$DATABASE_URL" ] || die "DATABASE_URL line not found in $ENV_FILE"
fi

# pg_dump uses libpq, which only understands the standard Postgres
# connection params. Prisma-specific query params (connection_limit,
# pool_timeout, pgbouncer, schema) trip it with:
#   "pg_dump: error: invalid URI query parameter: connection_limit"
# We strip those from the URL we pass to pg_dump. Override the whole
# thing by setting DATABASE_URL_DUMP explicitly (useful for a
# read-only replica or a dedicated dump user).
strip_prisma_params() {
  local url="$1" name
  for name in connection_limit pool_timeout pgbouncer schema; do
    # Three positions for the param to live in the query string —
    # handle each so we never leave an orphan `?`, `&`, or `?&`.
    # 1) first param followed by more params:  ?name=val&...   ->  ?
    url="$(printf '%s' "$url" | sed -E "s/\\?${name}=[^&]*&/?/g")"
    # 2) middle/last param after others:       &name=val       ->  (empty)
    url="$(printf '%s' "$url" | sed -E "s/&${name}=[^&]*//g")"
    # 3) only param (nothing else in query):   ?name=val$      ->  (drop ?)
    url="$(printf '%s' "$url" | sed -E "s/\\?${name}=[^&]*$//g")"
  done
  printf '%s' "$url"
}

DUMP_URL="${DATABASE_URL_DUMP:-$(strip_prisma_params "$DATABASE_URL")}"

# --- Resolve docker network for pg_dump -------------------------------------
# By default we run pg_dump from inside the same docker network the
# backend container uses, so it presents the same source IP to
# Postgres — that's the IP your pg_hba.conf already whitelists.
#
# Running pg_dump with --network host instead makes the container
# present the host's external IP, which is almost always NOT in
# pg_hba.conf and produces:
#   FATAL: no pg_hba.conf entry for host "<public-ip>", user ...
#
# Auto-detect any docker network ending in "_app-network" (compose
# prefixes named networks with the project = folder name). Set
# BACKUP_NETWORK=host to force the old host-network behaviour if your
# Postgres really is reachable that way.
NETWORK_FALLBACK_WARN=""
if [ -z "${BACKUP_NETWORK:-}" ]; then
  BACKUP_NETWORK="$(docker network ls --format '{{.Name}}' | grep -E '(^|_)app-network$' | head -n1 || true)"
  if [ -z "$BACKUP_NETWORK" ]; then
    NETWORK_FALLBACK_WARN="no *_app-network docker network found — falling back to --network host"
    BACKUP_NETWORK="host"
  fi
fi

# --- Resolve uploads volume -------------------------------------------------
if [ -z "${UPLOADS_VOLUME:-}" ]; then
  # Compose namespaces volumes with the project name (folder name by
  # default, e.g. "<compose-project>_pm_uploads"). Find the first one
  # whose suffix matches.
  UPLOADS_VOLUME="$(docker volume ls --format '{{.Name}}' | grep -E '(^|_)pm_uploads$' | head -n1 || true)"
fi
[ -n "${UPLOADS_VOLUME:-}" ] || die "could not auto-detect pm_uploads volume; set UPLOADS_VOLUME manually"
docker volume inspect "$UPLOADS_VOLUME" >/dev/null 2>&1 || die "docker volume '$UPLOADS_VOLUME' does not exist"

mkdir -p "$BACKUP_DIR"
# Now that the directory exists, point the log mirrors at it. backup.log
# grows (full history); backup-latest.log is reset so it holds only THIS run.
RUN_LOG="$BACKUP_DIR/backup.log"
LATEST_LOG="$BACKUP_DIR/backup-latest.log"
: >"$LATEST_LOG" 2>/dev/null || true

TS="$(date -u +%Y%m%dT%H%M%SZ)"
DB_OUT="$BACKUP_DIR/db_${TS}.sql.gz"
UPL_OUT="$BACKUP_DIR/uploads_${TS}.tar.gz"
# Stable "always the newest" filenames, overwritten every run. Grab these
# when you just want "the latest good backup" without hunting timestamps.
DB_LATEST="$BACKUP_DIR/db_latest.sql.gz"
UPL_LATEST="$BACKUP_DIR/uploads_latest.tar.gz"

log "starting backup → $BACKUP_DIR"
log "  pg_dump   target: ${DB_OUT}"
log "  pg_dump   network: ${BACKUP_NETWORK}"
[ -n "$NETWORK_FALLBACK_WARN" ] && log "  warn: $NETWORK_FALLBACK_WARN"
log "  uploads   volume: ${UPLOADS_VOLUME} → ${UPL_OUT}"

# --- 1. Postgres dump -------------------------------------------------------
# Run pg_dump from a throwaway postgres:16-alpine container, joined to
# the SAME docker network the backend uses. That way Postgres sees the
# same source IP as the live app — already whitelisted in pg_hba.conf.
# Override with BACKUP_NETWORK=host if your Postgres is reachable
# directly from the host's network (unusual setup).
docker run --rm --network "$BACKUP_NETWORK" \
  -e DB_URL="$DUMP_URL" \
  postgres:16-alpine \
  sh -c 'pg_dump --no-owner --no-privileges --clean --if-exists "$DB_URL" | gzip -9' \
  > "$DB_OUT" \
  || die "pg_dump failed"

DB_SIZE="$(stat -c %s "$DB_OUT" 2>/dev/null || stat -f %z "$DB_OUT")"
[ "$DB_SIZE" -gt 1024 ] || die "pg_dump output suspiciously small (${DB_SIZE} bytes) — aborting"
log "  pg_dump   wrote ${DB_SIZE} bytes"

# --- 2. Uploads volume snapshot --------------------------------------------
# tar the volume from a tiny alpine container. The volume is mounted RO
# and the output tarball is streamed to a bind-mount on the host so we
# never temporarily store the archive inside the container's writable layer.
docker run --rm \
  -v "${UPLOADS_VOLUME}:/data:ro" \
  -v "$(pwd)/${BACKUP_DIR}:/out" \
  alpine:3.20 \
  sh -c "cd /data && tar czf /out/$(basename "$UPL_OUT") ." \
  || die "uploads tar failed"

UPL_SIZE="$(stat -c %s "$UPL_OUT" 2>/dev/null || stat -f %z "$UPL_OUT")"
log "  uploads   wrote ${UPL_SIZE} bytes"

# --- 3. Refresh the "latest" pointers ---------------------------------------
# Overwrite the stable db_latest / uploads_latest files with this run's
# artefacts. Copy (not move/symlink) so the timestamped history stays intact
# AND there's always a fixed filename holding the newest good backup. We only
# reach here after both dumps passed their size sanity-checks, so "latest" is
# never left pointing at a truncated/failed dump.
cp -f "$DB_OUT" "$DB_LATEST" && cp -f "$UPL_OUT" "$UPL_LATEST" \
  || die "failed to refresh latest pointers"
log "  latest    refreshed $(basename "$DB_LATEST") + $(basename "$UPL_LATEST")"

# --- 4. Retention -----------------------------------------------------------
# Prune only the TIMESTAMPED history; never the *_latest.* pointers (they're
# always current, and must survive even a long gap between runs).
if [ "$RETENTION_DAYS" -gt 0 ]; then
  PURGED="$(find "$BACKUP_DIR" -maxdepth 1 -type f ! -name '*_latest.*' \( -name 'db_*.sql.gz' -o -name 'uploads_*.tar.gz' \) -mtime "+${RETENTION_DAYS}" -print -delete | wc -l)"
  log "  retention pruned ${PURGED} file(s) older than ${RETENTION_DAYS}d"
fi

log "backup OK"
