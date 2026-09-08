#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# PM Tool — restore script (the other half of backup.sh)
#
# Restores the database and/or the uploads volume from artefacts produced by
# backup.sh. By default it uses the "latest" pointers (db_latest.sql.gz /
# uploads_latest.tar.gz); pass explicit files to roll back to a point in time.
#
# THIS IS DESTRUCTIVE. The DB dump was taken with `--clean --if-exists`, so
# it DROPS and recreates every object; the uploads restore WIPES the volume
# before untarring. You are prompted before anything happens (skip with -y).
#
# Usage:
#   ./scripts/restore.sh                       # restore DB + uploads from *_latest
#   ./scripts/restore.sh --db-only             # only the database
#   ./scripts/restore.sh --uploads-only        # only the uploads volume
#   ./scripts/restore.sh --db-file backups/db_20260805T0230Z.sql.gz
#   ./scripts/restore.sh --uploads-file backups/uploads_20260805T0230Z.tar.gz
#   ./scripts/restore.sh -y                     # no confirmation prompt
#
# Env (same resolution as backup.sh):
#   BACKUP_DIR (default ./backups), ENV_FILE (default ./backend/.env),
#   DATABASE_URL / DATABASE_URL_DUMP, BACKUP_NETWORK, UPLOADS_VOLUME,
#   COMPOSE_FILE (default ./docker-compose.yml), BACKEND_SERVICE (default backend)
# ----------------------------------------------------------------------------

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
ENV_FILE="${ENV_FILE:-./backend/.env}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.yml}"
BACKEND_SERVICE="${BACKEND_SERVICE:-backend}"

DB_FILE=""; UPL_FILE=""; DO_DB=1; DO_UPL=1; ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --db-file) DB_FILE="$2"; shift 2 ;;
    --uploads-file) UPL_FILE="$2"; shift 2 ;;
    --db-only) DO_UPL=0; shift ;;
    --uploads-only) DO_DB=0; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || die "docker not on PATH"

# Default to the "latest" pointers when no explicit file was given.
[ -n "$DB_FILE" ]  || DB_FILE="$BACKUP_DIR/db_latest.sql.gz"
[ -n "$UPL_FILE" ] || UPL_FILE="$BACKUP_DIR/uploads_latest.tar.gz"

# --- Resolve DATABASE_URL (same logic as backup.sh) -------------------------
if [ "$DO_DB" -eq 1 ] && [ -z "${DATABASE_URL:-}" ]; then
  [ -f "$ENV_FILE" ] || die "no DATABASE_URL and $ENV_FILE not found"
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
  [ -n "$DATABASE_URL" ] || die "DATABASE_URL line not found in $ENV_FILE"
fi
strip_prisma_params() {
  local url="$1" name
  for name in connection_limit pool_timeout pgbouncer schema; do
    url="$(printf '%s' "$url" | sed -E "s/\\?${name}=[^&]*&/?/g")"
    url="$(printf '%s' "$url" | sed -E "s/&${name}=[^&]*//g")"
    url="$(printf '%s' "$url" | sed -E "s/\\?${name}=[^&]*$//g")"
  done
  printf '%s' "$url"
}
RESTORE_URL="${DATABASE_URL_DUMP:-$(strip_prisma_params "${DATABASE_URL:-}")}"

# --- Resolve docker network -------------------------------------------------
if [ -z "${BACKUP_NETWORK:-}" ]; then
  BACKUP_NETWORK="$(docker network ls --format '{{.Name}}' | grep -E '(^|_)app-network$' | head -n1 || true)"
  [ -n "$BACKUP_NETWORK" ] || BACKUP_NETWORK="host"
fi

# --- Resolve uploads volume -------------------------------------------------
if [ "$DO_UPL" -eq 1 ] && [ -z "${UPLOADS_VOLUME:-}" ]; then
  UPLOADS_VOLUME="$(docker volume ls --format '{{.Name}}' | grep -E '(^|_)pm_uploads$' | head -n1 || true)"
  [ -n "${UPLOADS_VOLUME:-}" ] || die "could not auto-detect pm_uploads volume; set UPLOADS_VOLUME"
fi

# --- Pre-flight checks ------------------------------------------------------
if [ "$DO_DB" -eq 1 ]; then
  [ -f "$DB_FILE" ] || die "DB backup not found: $DB_FILE"
fi
if [ "$DO_UPL" -eq 1 ]; then
  [ -f "$UPL_FILE" ] || die "uploads backup not found: $UPL_FILE"
fi

echo
log "About to RESTORE (this OVERWRITES current data):"
[ "$DO_DB" -eq 1 ]  && log "  database  ← $DB_FILE   (network: $BACKUP_NETWORK)"
[ "$DO_UPL" -eq 1 ] && log "  uploads   ← $UPL_FILE  (volume: ${UPLOADS_VOLUME:-n/a})"
echo
if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Type "restore" to proceed: '
  read -r CONFIRM
  [ "$CONFIRM" = "restore" ] || die "aborted (you typed '$CONFIRM')"
fi

# --- Stop the backend so nothing writes mid-restore -------------------------
STOPPED=0
if docker compose -f "$COMPOSE_FILE" stop "$BACKEND_SERVICE" >/dev/null 2>&1; then
  STOPPED=1; log "stopped '$BACKEND_SERVICE'"
else
  log "warn: could not stop '$BACKEND_SERVICE' via compose — continuing (make sure it isn't writing)"
fi

# --- Restore database -------------------------------------------------------
if [ "$DO_DB" -eq 1 ]; then
  log "restoring database…"
  gunzip -c "$DB_FILE" | docker run --rm -i --network "$BACKUP_NETWORK" \
    postgres:16-alpine psql "$RESTORE_URL" >/dev/null \
    || die "database restore failed (backend left stopped so you can retry)"
  log "  database restored"
fi

# --- Restore uploads volume -------------------------------------------------
if [ "$DO_UPL" -eq 1 ]; then
  log "restoring uploads volume '$UPLOADS_VOLUME'…"
  docker run --rm \
    -v "${UPLOADS_VOLUME}:/data" \
    -v "$(cd "$(dirname "$UPL_FILE")" && pwd):/in:ro" \
    alpine:3.20 \
    sh -c "rm -rf /data/* /data/..?* /data/.[!.]* 2>/dev/null; tar xzf /in/$(basename "$UPL_FILE") -C /data" \
    || die "uploads restore failed (backend left stopped so you can retry)"
  log "  uploads restored"
fi

# --- Restart the backend ----------------------------------------------------
if [ "$STOPPED" -eq 1 ]; then
  docker compose -f "$COMPOSE_FILE" start "$BACKEND_SERVICE" >/dev/null 2>&1 \
    && log "started '$BACKEND_SERVICE'" \
    || log "warn: could not restart '$BACKEND_SERVICE' — start it manually"
fi

log "restore OK"
