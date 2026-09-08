# Template setup — new customer checklist

This repository is a **blank template** of the PM Tool. Nothing in it is
customer-specific: product name, copyright holder, logos, hosts, ports and
secrets are all configuration. Follow this list once per new installation.

## 1. Copy the template

Copy the whole folder to a new location named after the customer (the
folder name becomes the Docker Compose project name, which prefixes the
containers, network and volumes — e.g. `acme-pm_pm_uploads`). Do not
develop customer-specific changes inside the template itself.

## 2. Environment files (the only per-deployment files)

| File                   | Copy from                      | Holds                                                         |
| ---------------------- | ------------------------------ | ------------------------------------------------------------- |
| `.env`                 | `.env.example`                 | branding, public URLs, ports, JWT secrets, proxy, data paths   |
| `backend/.env`         | `backend/.env.example`         | `DATABASE_URL`, SMTP credentials, local-dev JWT/CORS values    |

Both real files are git-ignored. Required before first start:

- `APP_NAME` — product name (UI, browser tab, emails, Excel exports).
- `COPYRIGHT_HOLDER` — legal entity for the © line.
- `APP_ORIGIN` / `API_URL` — the public frontend / API URLs users will hit.
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — generate fresh per install:
  `openssl rand -hex 48`. Compose refuses to start without them.
- `DATABASE_URL` in `backend/.env` — Postgres connection string.
- Optional: `SMTP_*` / `MAIL_FROM` (leave `SMTP_HOST` empty to log mail to
  `/app/logs/sent-mail.log` instead of sending), `HTTP(S)_PROXY`,
  `UPLOADS_PATH` / `LOGS_PATH` / `BACKUPS_PATH`.

## 3. Branding

- Name and © holder: `.env` only (see above). Never hardcode them in source
  — `frontend/src/lib/appInfo.js` and `backend/src/lib/mailer.js` read them
  from the environment.
- Logos — replace these placeholder SVGs with the customer's artwork,
  **keeping the file names and roughly the aspect ratios**:
  - `frontend/public/favicon.svg` (square, light UI) and
    `frontend/public/favicon_bg_dark.svg` (square, dark UI)
  - `frontend/src/assets/logo_icon_light_background.svg` /
    `logo_icon_dark_background.svg` (square mark)
  - `frontend/src/assets/logo_desktop_light_background.svg` /
    `logo_desktop_dark_background.svg` (icon + wordmark, ≈ 3.4 : 1)
- Optional: accent colours in `frontend/tailwind.config.js` /
  `frontend/src/index.css`.

Branding values are baked into the frontend bundle at **build time** —
after changing `.env` run `docker compose build frontend`.

## 4. Database

- Point `DATABASE_URL` at an empty PostgreSQL 16 database.
- Schema is applied with `prisma migrate deploy` (the backend image runs it
  on start — see `docs/migrations.md`). Never edit old migrations; add new
  ones with `npm run db:migrate:dev` in `backend/`.
- Option catalogues (statuses, priorities, phases, …) are seeded on first
  boot by `ensureDefaultTemplates()`.

## 5. First start

```
cp .env.example .env && cp backend/.env.example backend/.env   # then edit both
docker compose up -d --build
docker compose logs -f backend                                 # wait for "listening"
```

Open `APP_ORIGIN` and **register the first user** — the boot-time
`ensureAdmin()` promotes the oldest account to ADMIN/ACTIVE when no admin
exists, so the first registration becomes the administrator. Every later
registration waits for admin approval.

## 6. Operations

- Backups: `scripts/backup.sh` (Linux) / `scripts/backup.ps1` (Windows),
  restore with `scripts/restore.sh` — wiring and cron line in
  `scripts/README.md`.
- Boot order, environment-variable matrix and "where to look when something
  breaks": `docs/operations.md`.
- Versioning and the "What's new" workflow: `MANIFEST.md`. Start the
  customer's history from the single `v1.0.0 — Initial release` entry in
  `backend/RELEASE_NOTES.md`.

## 7. Before handing over — sanity grep

Run from the repo root; it should print nothing:

```
grep -rIn --exclude-dir=node_modules -iE "todo-customer|change_me" .
grep -rIl --exclude-dir=node_modules -E "\b[0-9]{1,3}(\.[0-9]{1,3}){3}\b" . | grep -v -E "127\.0\.0\.1|\.svg$"
```

## Keeping the template itself clean

When a customer change is worth keeping for everyone, port it back here
**without** customer names, hosts or data, bump the template version in the
three places listed in `MANIFEST.md`, and add a `## N.` entry to
`backend/RELEASE_NOTES.md`.
