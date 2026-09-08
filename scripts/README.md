# scripts/

Operational scripts that live outside the application code. None of these
are wired into the app at runtime — they're meant to be invoked by cron,
CI, or a human at a shell.

## `backup.sh` (Linux / macOS) and `backup.ps1` (Windows)

Produces these artefacts in `./backups/`:

| File | Content |
| --- | --- |
| `db_<UTC>.sql.gz` | `pg_dump --clean --if-exists --no-owner --no-privileges` of the Postgres URL in `backend/.env`, gzipped. |
| `uploads_<UTC>.tar.gz` | tar.gz of the `pm_uploads` Docker volume (avatars, project files, chat attachments, app logos). |
| `db_latest.sql.gz` | **Overwritten every run** — a copy of the newest good DB dump. Grab this when you just want "the latest backup" without hunting timestamps. |
| `uploads_latest.tar.gz` | **Overwritten every run** — a copy of the newest good uploads snapshot. |
| `backup.log` | Append-only log of every run (full history). |
| `backup-latest.log` | **Overwritten every run** — just the most recent run's log; `tail` this to see how the last backup went. |

The timestamped files are your **point-in-time history** (rotated by
`RETENTION_DAYS`); the `*_latest.*` files are a stable, always-current
pointer that is **never** pruned. The "latest" copies are only refreshed
*after* both dumps pass a size sanity-check, so they never point at a
half-written/failed dump. You get both worlds: roll back to any day, or just
grab "latest".

Both jobs run in throwaway Docker containers (`postgres:16-alpine` and
`alpine:3.20`), so the host does **not** need `pg_dump` or `tar` installed
locally — just Docker.

### Run it

```bash
# Linux production
./scripts/backup.sh

# With overrides
BACKUP_DIR=/data/backups RETENTION_DAYS=30 ./scripts/backup.sh

# Windows dev
.\scripts\backup.ps1
.\scripts\backup.ps1 -BackupDir D:\backups -RetentionDays 30
```

### Wire it to cron

```cron
# /etc/cron.d/pm-backup — nightly at 02:30 UTC, log to syslog-friendly file
30 2 * * * root cd /opt/pm-tool && /opt/pm-tool/scripts/backup.sh >> /var/log/pm-backup.log 2>&1
```

If you use [healthchecks.io](https://healthchecks.io) or similar, append a
`curl` ping after a successful run so a silent backup failure pages you:

```bash
./scripts/backup.sh && curl -fsS -m 10 --retry 3 https://hc-ping.com/<uuid>
```

### Configuration

| Var | Default | Notes |
| --- | --- | --- |
| `BACKUP_DIR` | `./backups` | Where artefacts land. Should be a separate disk / volume in production. |
| `ENV_FILE` | `./backend/.env` | Where to read `DATABASE_URL` from. |
| `DATABASE_URL` | (parsed from `.env`) | Override if you want to dump a replica or a different DB. |
| `DATABASE_URL_DUMP` | (derived from `DATABASE_URL`) | Optional override of the URL passed to `pg_dump`. By default the script strips Prisma-only query params (`connection_limit`, `pool_timeout`, `pgbouncer`, `schema`) — libpq rejects them with `invalid URI query parameter`. Set this if you have a dedicated replica or a read-only dump user. |
| `UPLOADS_VOLUME` | auto-detected | Looks for any docker volume ending in `_pm_uploads`. Set explicitly if you have multiple compose projects on the same host. |
| `BACKUP_NETWORK` | auto-detected | Docker network the `pg_dump` container joins. Defaults to the first `*_app-network` (the one the backend uses) so Postgres sees the same source IP — already whitelisted in `pg_hba.conf`. Set to `host` to use the host network, or any other network name. If you see `no pg_hba.conf entry for host "<your-public-ip>"`, you're on `host` when you shouldn't be. |
| `RETENTION_DAYS` | `14` | Files older than this are pruned at the end of each run. Set to `0` to disable rotation. |

## Restore

**⚠ Restores are destructive** — the DB dump drops & recreates every object,
and the uploads restore wipes the volume first. Always know which snapshot
you're restoring.

### Easiest: `restore.sh` (Linux / Docker)

Guided, one command. Defaults to the `*_latest` pointers; stops the backend,
restores, restarts it. Prompts before doing anything (type `restore`).

```bash
./scripts/restore.sh                    # DB + uploads, from *_latest
./scripts/restore.sh --db-only          # database only
./scripts/restore.sh --uploads-only     # uploads only
# roll back to a specific point in time:
./scripts/restore.sh \
  --db-file backups/db_20260805T023000Z.sql.gz \
  --uploads-file backups/uploads_20260805T023000Z.tar.gz
./scripts/restore.sh -y                 # skip the confirmation prompt (cron/CI)
```

If a step fails it leaves the backend stopped so you can retry safely.

### Manual (any host, or when you need full control)

### Database

```bash
# 1. Stop the backend so nothing writes during restore.
docker compose stop backend

# 2. Pipe the gzipped dump into psql. `--clean --if-exists` in the dump
#    already drops existing objects, so this is safe against a populated DB.
#    Join the same docker network you backed up from, so pg_hba.conf
#    accepts the connection.
gunzip -c backups/db_20260517T023000Z.sql.gz | \
  docker run --rm -i --network <compose-project>_app-network postgres:16-alpine \
    psql "postgresql://postgres:PASSWORD@HOST:5433/pmtool"

# 3. Restart.
docker compose start backend
```

### Uploads volume

```bash
# 1. Stop the backend (release file locks).
docker compose stop backend

# 2. Wipe the existing volume, then untar the snapshot into it.
docker run --rm \
  -v <compose-project>_pm_uploads:/data \
  -v $(pwd)/backups:/in:ro \
  alpine:3.20 \
  sh -c "rm -rf /data/* /data/..?* /data/.[!.]* 2>/dev/null; \
         tar xzf /in/uploads_20260517T023000Z.tar.gz -C /data"

# 3. Restart.
docker compose start backend
```

Test the restore at least once a quarter — an untested backup is a future
incident, not a backup. Cheapest way is to restore into a throwaway
`pmtool_restore_test` database with a different name in the URL and run
the backend container against it.

## Logs — where they live

| Log | Location | How to read |
| --- | --- | --- |
| **App (backend) runtime** | container stdout/stderr, captured by Docker | `docker compose logs -f backend` (add `--since 1h` / `--tail 200`). Persisted per Docker's logging driver. |
| **App log files** | `pm_logs` Docker volume → `/app/logs` (override with `LOGS_PATH`) | e.g. `sent-mail.log` (outbound email audit). `docker compose exec backend sh -c 'ls -la /app/logs'`. |
| **Backup runs** | `./backups/backup.log` (history) + `./backups/backup-latest.log` (last run only) | `tail -f backups/backup.log` or `cat backups/backup-latest.log`. |
| **Activity / audit trail** (in-app) | Postgres (`ActivityEvent` table) | the **Activity feed** page in the app — not a file. |

Keep `backups/` (and, if you can, the `pm_logs` volume) on a **separate
disk/volume** from the database, and copy `backups/` **off the host**
regularly (rsync/rclone to another server or object storage) — a backup that
lives only on the machine it's backing up won't survive that machine dying.
