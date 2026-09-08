# Operations reference

> Maintainer-facing. Boot sequence, environment variables and a first-file-to-check table. Deployment specifics (hosts, ports, proxies) live in each installation's `.env`, never in the repo.

## Runtime & configuration

### Boot order

1. `requireSecret('JWT_ACCESS_SECRET')` / `requireSecret('JWT_REFRESH_SECRET')`
  — fails fast if either is missing or weak.
2. `ensureAdmin()` — bootstraps the first admin if the table is empty.
3. `backfillProjectParticipants()` — fixes legacy rows missing
  owner-as-participant.
4. `ensureDefaultTemplates()` — seeds every option catalogue.
5. `backfillEntityCodes()` — stamps `P-…` / `T-…` / `ST-…` codes on
  legacy rows.
6. `startAttachmentSweeper()` — garbage-collects expired message
  attachments.
7. `startDeadlineSweepScheduler()` — runs the task-deadline alerting
  sweep (30s after boot, then every 24h).
8. WebSocket server attaches to the same HTTP server.

### Configuration matrix


| Var                                                                                 | Where it's read                | What it controls                                                                                      |
| ----------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `PORT`                                                                              | `index.js`                     | HTTP listen port (default 5000).                                                                      |
| `CORS_ORIGIN`                                                                       | `index.js`, `realtime.js`      | Origin allowed for HTTP + WebSocket.                                                                  |
| `JWT_ACCESS_SECRET`                                                                 | `lib/jwt.js`                   | Access-token HMAC secret. ≥32 chars.                                                                  |
| `JWT_REFRESH_SECRET`                                                                | `lib/jwt.js`                   | Refresh-token HMAC secret. ≥32 chars.                                                                 |
| `ACCESS_TOKEN_TTL`                                                                  | `lib/jwt.js`                   | Access-token TTL (default `15m`).                                                                     |
| `REFRESH_TOKEN_TTL_DAYS`                                                            | `lib/jwt.js`                   | Refresh-token TTL (default 7 days).                                                                   |
| `FILE_URL_SECRET`                                                                   | `lib/upload.js`                | HMAC key for signed file URLs. Falls back to `JWT_ACCESS_SECRET` if absent.                           |
| `FILE_URL_TTL_SECONDS`                                                              | `lib/upload.js`                | Signed-URL lifetime (default 600s).                                                                   |
| `DATABASE_URL`                                                                      | `lib/prisma.js`                | Postgres connection string.                                                                           |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` / `MAIL_FROM` | `lib/mailer.js`                | Email transport. Leave `SMTP_HOST` empty to log mail to `/app/logs/sent-mail.log` instead of sending. |
| `APP_NAME`                                                                          | `lib/mailer.js`, `lib/excel.js` | Product name in emails and Excel exports (set once in root `.env`).                                  |
| `VITE_APP_NAME` / `VITE_COPYRIGHT_HOLDER`                                           | frontend build                 | Product name / © holder shown in the UI. Wired from `APP_NAME` / `COPYRIGHT_HOLDER` in root `.env`.  |
| `APP_ORIGIN`                                                                        | `lib/mailer.js`, `realtime.js` | Public URL used to build deep-links in emails.                                                        |
| `NODE_ENV`                                                                          | several                        | Toggles dev-only behaviours (reset URL log, cookie `secure`). Set to `production` for prod.           |
| `VITE_API_URL`                                                                      | frontend build                 | Public API URL the browser will call.                                                                 |

## Where to look when something breaks

| Symptom                                      | First file to check                                                                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Login fails                                  | `backend/src/routes/auth.js` (POST `/login`), `lib/jwt.js`.                                                                                   |
| File downloads return 401 / 403              | `lib/upload.js` (`verifyFileSignatureMiddleware`), then `signFileUrl` callers.                                                                |
| WebSocket dropping after a few seconds       | `lib/realtime.js`, then check `CORS_ORIGIN`.                                                                                                  |
| Emails not arriving                          | `lib/mailer.js`, then SMTP env vars, then `/app/logs/sent-mail.log` if SMTP_HOST is empty.                                                    |
| Pending approvals badge wrong                | `lib/notify.js` `broadcastPendingUserCount()`, then `RealtimeContext`.                                                                        |
| Task overdue alerts not firing               | `lib/deadlineAlerts.js` `runDeadlineSweep()`, and trigger manually via `POST /api/notifications/run-deadline-sweep`.                          |
| Release file uploaded but no Download button | Confirm `release.fileUrl` is populated in the DB. The button shows up automatically when present.                                             |
| Capability change not taking effect          | `middleware/auth.js` 30s `userCache` — the user route calls `invalidateUserCache(id)` on every capability edit, so this should be sub-second. |


---
