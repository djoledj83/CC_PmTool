# Developer Manifest

> Maintainer-facing. **Not** shipped to end users. Keep this file current —
> it's the quick "how do I release / where does what live" reference.

## Identity

- **Name / copyright holder:** configuration, not code — `APP_NAME` and
  `COPYRIGHT_HOLDER` in the root `.env` (see `TEMPLATE_SETUP.md`). The
  backend reads `APP_NAME` directly; the frontend gets `VITE_APP_NAME` /
  `VITE_COPYRIGHT_HOLDER` baked in at build time via `docker-compose.yml`.
- **Version:** v1.0.0 (semantic versioning)
- **Single source of truth for the version shown in the UI:**
  `frontend/src/lib/appInfo.js` (surfaced in the sidebar footer and
  Help → About & version).
- **Logos:** placeholder SVGs in `frontend/public/` and
  `frontend/src/assets/` — replace per customer, keep the file names.

## Versioning policy — semantic versioning (`MAJOR.MINOR.PATCH`)

- **PATCH** (`1.0.x`) — backwards-compatible bug fixes / small tweaks.
- **MINOR** (`1.x.0`) — new, backwards-compatible features.
- **MAJOR** (`x.0.0`) — breaking changes or big milestones.

On every real release, bump the version in **three places, kept in sync**:

1. `frontend/src/lib/appInfo.js` → `APP_VERSION` (drives the in-app display)
2. `frontend/package.json` → `version`
3. `backend/package.json` → `version`

## "What's new" workflow — do this for every user-visible change

Whenever a change ships something a user would notice, before committing:

1. Add a section to **`backend/RELEASE_NOTES.md`** (the single canonical
   file — see below). Use the exact heading shape the parser needs:

   ```
   ## <next-sequential-number>. v<version> — <short title>

   - What changed (a few tight bullets).
   - Requires migration `…` — if any.
   - Files: `path/one`, `path/two`.
   ```

2. **Newest section goes at the BOTTOM** of the file. The in-app "What's
   new" popover shows sections newest-last, and its parser splits on
   `## N. Title` headings (regex `^##\s+(\d+[a-z]?)\.\s+`), so keep that
   exact format — no `## [1.0.0]`-style headings.
3. **Bump the version** per the semver rules above if it's a real release,
   and update the three version locations.
4. Commit.

Rule of thumb: if you'd tell a user *"hey, we added X"*, it belongs in the
release notes. Pure internal refactors with no user-facing effect don't
need an entry.

## Release notes / changelog

- **Canonical file:** `backend/RELEASE_NOTES.md` — the ONLY copy. The API
  (`GET /api/release-notes`) reads it in both environments:
  - **Local dev:** its candidate-path list falls through to
    `backend/RELEASE_NOTES.md`.
  - **Docker:** `docker-compose.yml` mounts `./backend/RELEASE_NOTES.md`
    read-only at `/app/RELEASE_NOTES.md`, so edits show up immediately (the
    popover keys off the file's mtime) with no image rebuild.
  There used to be a second, drifted copy at the repo root — it was
  consolidated into this file and removed so the two can't diverge again.
  Edit **only** this file.
- **Surfaced in-app:** the "What's new" sparkle popover in the top bar
  (`frontend/src/components/ChangelogPopover.jsx`) and Help → *About &
  version* (`frontend/src/pages/Help.jsx`).
- **Format constraint:** feature sections MUST be `## N. Title` (numbered)
  or the parser won't see them.

## Architecture at a glance

- **Frontend:** React + Vite + Tailwind + shadcn/ui, React Router. Pages in
  `frontend/src/pages`, shared UI in `frontend/src/components`, small libs in
  `frontend/src/lib`.
- **Backend:** Node / Express + Prisma (PostgreSQL) + Socket.IO. Routes in
  `backend/src/routes`, shared helpers in `backend/src/lib`.
- **Auth:** JWT, capability-based RBAC (`isAdmin`, `hasCapability`).
- **Soft delete:** tasks, projects and tickets soft-delete via a Prisma
  client extension (`backend/src/lib/prisma.js`) — deleted rows are hidden
  from all reads and restorable from the Activity feed.
- **Deploy:** Docker Compose behind a corporate proxy; DB migrations via
  `prisma migrate deploy`.
- Full module → files → storage map lives in `RELEASE_NOTES.md`
  ("Modules at a glance"); boot order, env-var matrix and a
  "where to look when something breaks" table in `docs/operations.md`.

## Backup, restore & logs

- **Backup:** `scripts/backup.sh` (Linux/Docker) / `scripts/backup.ps1`
  (Windows) — `pg_dump` of Postgres + tar of the uploads volume, into
  `./backups/`. Each run writes a **timestamped** artefact (point-in-time
  history, pruned by `RETENTION_DAYS`) **and** overwrites `db_latest.sql.gz`
  / `uploads_latest.tar.gz` (always the newest good backup). Wire it to cron
  (see `scripts/README.md`); it isn't run by the app.
- **Restore:** `scripts/restore.sh` — guided, defaults to the `*_latest`
  files, stops/starts the backend, prompts before overwriting. Or restore a
  specific timestamp with `--db-file` / `--uploads-file`.
- **Logs:** backend runtime → `docker compose logs backend`; app log files →
  `pm_logs` volume at `/app/logs`; backup runs → `backups/backup.log` +
  `backup-latest.log`; in-app audit → the Activity feed (Postgres).
- Full details + the cron one-liner: `scripts/README.md`.

## Roadmap / not yet built

- **Mail ticketing** *(planned, not started)* — email ↔ ticket bridge:
  - Inbound: a requester emails a support address → open a new ticket (or
    append to an existing one when the subject/headers carry a ticket
    reference). Needs an inbound mail pipeline (IMAP poll or provider
    webhook) and an address/message-id → ticket mapping.
  - Outbound: resolvers can reply from email and have the response threaded
    back into the ticket conversation; ticket replies email the requester.
  - Considerations: reply-address parsing, HTML/plain sanitisation,
    attachment handling, loop/auto-reply protection, per-type routing.
- (Add future ideas here as they come up.)
