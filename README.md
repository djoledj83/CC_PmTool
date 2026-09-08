# CC_PmTool

Customer-neutral **template** of the PM Tool — a project-management platform
with projects, tasks & sprints, time tracking, application release management,
ticketing / help-desk, messaging, notifications and a full activity audit
trail, behind capability-based RBAC.

| Layer    | Stack                                                    |
| -------- | -------------------------------------------------------- |
| Frontend | React 18 · Vite · Tailwind · shadcn/ui · React Router    |
| Backend  | Node · Express · Prisma (PostgreSQL 16) · Socket.IO       |
| Deploy   | Docker Compose (nginx-served SPA + API container)        |

## Start here

- **New installation for a customer:** follow [`TEMPLATE_SETUP.md`](TEMPLATE_SETUP.md) —
  copy the folder, fill in `.env` / `backend/.env` from the `.env.example`
  files, replace the placeholder logos, `docker compose up -d --build`.
- **Maintaining the code:** [`MANIFEST.md`](MANIFEST.md) (versioning, release-notes
  workflow, where things live), [`docs/operations.md`](docs/operations.md)
  (boot order, env-var matrix, troubleshooting), [`docs/`](docs/) for
  architecture, permissions model and migrations.
- **Backups / restore:** [`scripts/README.md`](scripts/README.md).

Branding (product name, © holder, logos) and every deployment setting are
configuration — nothing customer-specific lives in this repository.

## Local development

```
cd backend  && cp .env.example .env && npm install && npm run dev     # API on :5000
cd frontend && npm install && npm run dev                              # UI on :5173
```

Set `DATABASE_URL` in `backend/.env` to a PostgreSQL 16 instance first; the
schema is applied with `npm run db:migrate:deploy`.
