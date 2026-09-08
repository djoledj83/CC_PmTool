# Release Notes

> Living document: what's shipped, how the modules fit together. Operational
> notes live in `docs/operations.md`; release/versioning procedure in
> `MANIFEST.md`. Sections are ordered oldest-first; the in-app "What's new"
> popover shows them newest-last and only recognises `## N. Title` headings.

Version: **v1.0.0** (semantic versioning) · Last updated: **2026-09-07**

---

## 1. What this app is

A unified workspace for a small-to-mid product/engineering org. Four
pillars:

1. **Project management** — projects, phases, tasks, subtasks, notes,
  files, billing, teams.
2. **Application release management** — applications, releases (Test →
  Pilot → Approved), per-release artifacts and operational
   checkpoints, cross-app activity timeline.
3. **Time tracking** — live timer + manual entries, rolled up to
  tasks, projects and applications, with charts and CSV export.
4. **SDLC procedure / activity audit** — full audit feed across users,
  projects, tasks, files, time entries, applications and releases;
   per-user "My to-do" view; deadline alerts.

Plus the supporting infrastructure: real-time chat with attachments,
in-app notifications + email digests, granular role + capability
RBAC, multi-select filters, sticky preferences, CSV / XLSX exports.

---

## 2. Modules at a glance

| Module                  | Frontend                                                                                                                                                               | Backend                                                                   | Storage                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Auth & accounts         | `pages/Login.jsx`, `pages/Register.jsx`, `pages/ForgotPassword.jsx`, `pages/ResetPassword.jsx`, `components/ProfileDialog.jsx`                                         | `routes/auth.js`, `routes/users.js`, `lib/jwt.js`, `lib/resetTokens.js`   | `User`, `PasswordResetToken`                                                                                      |
| Projects                | `pages/Projects.jsx`, `pages/ProjectDetail.jsx`, `components/ProjectFormDialog.jsx`                                                                                    | `routes/projects.js`, `routes/phases.js`, `routes/participants.js`        | `Project`, `Phase`, `ProjectParticipant`                                                                          |
| Tasks / subtasks        | `pages/ProjectDetail.jsx` (Tasks tab)                                                                                                                                  | `routes/tasks.js`                                                         | `Task`, `Subtask`                                                                                                 |
| Notes & files           | `pages/ProjectDetail.jsx` (Notes & Files tabs)                                                                                                                         | `routes/notes.js`, `routes/files.js`, `lib/upload.js`                     | `Note`, `File`, signed `/uploads/files/*`                                                                         |
| Billing                 | `pages/Billing.jsx`                                                                                                                                                    | `routes/billing.js`, `routes/exports.js`                                  | `Project.{price, paidAt, internalSettlement, clientSettlement, ...}`                                              |
| Reassignments           | `pages/Reassignments.jsx`                                                                                                                                              | `routes/reassignments.js`                                                 | `TaskReassignmentRequest`                                                                                         |
| Teams                   | `pages/Teams.jsx`                                                                                                                                                      | `routes/teams.js`                                                         | `Team`, `TeamMember`, `ProjectTeam`, `PhaseTeam`                                                                  |
| Activity feed           | `pages/Activities.jsx`                                                                                                                                                 | `routes/activities.js`, `lib/activityLog.js`                              | `Activity`                                                                                                        |
| Insights                | `pages/Insights.jsx`                                                                                                                                                   | `routes/insights.js`                                                      | derived                                                                                                           |
| Messages                | `pages/Messages.jsx`                                                                                                                                                   | `routes/conversations.js`, `lib/realtime.js`, `lib/messageAttachments.js` | `Conversation`, `Message`, `MessageAttachment`                                                                    |
| Notifications           | bell in `TopBar` + toasts                                                                                                                                              | `routes/notifications.js`, `lib/notify.js`, `lib/deadlineAlerts.js`       | `Notification`, `TaskDeadlineAlert`                                                                               |
| Time tracking           | `pages/TimeTracking.jsx`                                                                                                                                               | `routes/time.js`, `routes/exports.js`                                     | `TimeEntry`                                                                                                       |
| Applications & releases | `pages/Applications.jsx`, `pages/ApplicationDetail.jsx`, `components/ApplicationFormDialog.jsx`, `components/ReleaseFormDialog.jsx`, `components/CheckpointDialog.jsx` | `routes/applications.js`                                                  | `Application`, `AppRelease`, `AppReleaseNote`, `ReleaseCheckpoint`, `AppOsOption`, `AppPosTerminalOption`         |
| Templates (catalogues)  | `pages/Templates.jsx`                                                                                                                                                  | `routes/templates.js`, `lib/catalogs.js`                                  | `*Option` tables (status / priority / country / phase / project-type / app OS / app POS terminal / business unit) |
| To-do                   | `pages/Todos.jsx`                                                                                                                                                      | `routes/todos.js`                                                         | derived from `Task` / `Subtask`                                                                                   |
| Help                    | `pages/Help.jsx`                                                                                                                                                       | static — no API                                                           | —                                                                                                                 |

Modules added later (sprints & planning boards, ticketing / help-desk, products, entities & codes, announcements, requests, personal project groups) follow the same `pages/*` ↔ `routes/*` ↔ Prisma-model layout — extend this table when you add a module.


---

## 3. v1.0.0 — Initial release

- Template baseline: the full feature set described above — projects,
  phases, tasks & subtasks, notes & files, billing, teams, sprints &
  planning boards, time tracking (timer, manual entries, charts, exports),
  applications & releases, ticketing / help-desk with requester portal,
  messages, notifications & email digests, activity audit feed, RBAC with
  capabilities, option catalogues, light / dark / dim themes.
- Branding (name, © holder, logos) and all deployment settings are
  configuration — see `TEMPLATE_SETUP.md`.
- Database schema delivered as the `prisma/migrations` chain; apply with
  `prisma migrate deploy`.
