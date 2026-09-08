# Migration strategy

This document describes how the project should move from the current
`prisma db push` workflow to a proper migration history. **Nothing in
this document has been executed yet** — running `prisma migrate dev`
or `prisma migrate deploy` against a database is a one-way operation
that the project owner should kick off deliberately.

## Why migrate?

`prisma db push` is great for early-stage development: it sync's the
DB to whatever the schema currently says, no questions asked. The
trade-offs become painful as the project ages:

| Concern                                                      | `db push`                                      | `migrate`                                        |
| ------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------ |
| Reversible history                                           | None — only the latest schema is known         | Each change is a numbered, reviewable SQL file   |
| Production-safety                                            | Will silently drop columns / data              | Refuses to run without `--accept-data-loss` flag |
| Rollback (revert one feature)                                | Manual SQL                                     | `migrate resolve --rolled-back <name>`           |
| Multiple environments (dev / staging / prod) staying in sync | Drift-prone (no record of who applied what)    | Each env's `_prisma_migrations` table tracks it  |
| Onboarding a new developer                                   | "Run `db push`" — DB ends up at whatever HEAD  | Clone repo + `migrate deploy` reproduces history |
| Reviewability                                                | Schema diff in PR but no SQL                   | PR includes generated `.sql` for human review    |

The current schema (1.6k lines, ~38 models) is mature enough that this
trade-off is no longer balanced.

## Cutover plan

### Step 1 — Pick a low-traffic window

The migration baseline operation reads the live schema and writes its
SQL into `prisma/migrations/<timestamp>_init/migration.sql`. It does
not modify data, but the database is briefly locked while Prisma
inspects every table. Pick a moment when the app isn't being used.

### Step 2 — Take a backup first

```bash
ssh contabo
docker compose exec backend pg_dump \
    -U postgres \
    -h <db-host> \
    -d pmtool \
    -Fc > /backups/pre-migration-baseline.dump
```

(Adjust `-U` / `-h` / `-d` to whatever's in `backend/.env`.)

### Step 3 — Baseline the existing schema

On a developer machine that has `DATABASE_URL` pointing at production
**read-only access** (or, safer: on a freshly restored copy of the
production DB):

```bash
cd backend
npx prisma migrate diff \
    --from-empty \
    --to-schema-datamodel prisma/schema.prisma \
    --script > prisma/migrations/$(date +%Y%m%d%H%M%S)_init/migration.sql
```

This produces a single "initial" migration file representing the entire
current schema.

### Step 4 — Mark the migration as already applied

In production the schema already exists. Tell Prisma not to run the
init migration; just record that it's done:

```bash
npx prisma migrate resolve --applied <timestamp>_init
```

Once you've done this, the `_prisma_migrations` table will exist with
one row, and Prisma will consider production "in sync".

### Step 5 — Switch the boot command

Edit `backend/Dockerfile`:

```diff
- CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node src/index.js"]
+ CMD ["sh", "-c", "npx prisma migrate deploy && node src/index.js"]
```

`migrate deploy` applies any pending migrations in order. If everything
is already applied (production was baselined in step 4), it's a no-op.

### Step 6 — Daily workflow afterwards

For schema changes from this point on, **never edit `schema.prisma`
without creating a migration**:

```bash
cd backend
# 1. Edit schema.prisma to add/change a field.
# 2. Generate a migration with a descriptive name:
npm run db:migrate:dev -- --name add_user_upload_quota
#    -> writes prisma/migrations/<timestamp>_add_user_upload_quota/migration.sql
# 3. Commit BOTH schema.prisma AND the migration.sql.
# 4. Push. CI / docker rebuild applies them in production via
#    `migrate deploy` (no manual step needed).
```

The `npm run db:migrate:status` script (added in
`backend/package.json`) is useful for sanity-checking which migrations
are applied in any environment:

```bash
npm run db:migrate:status
# Database schema is up to date!
# (or)
# Following migration have not yet been applied:
#   20260521093000_add_user_upload_quota
```

## Recovery: undo a migration that broke production

If a migration is found to be bad after deploy:

1. Roll back the data with the backup taken in step 2.
2. Tell Prisma the migration didn't really apply:

   ```bash
   npx prisma migrate resolve --rolled-back <name>
   ```

3. Delete the broken migration directory from git, commit, deploy
   again.

## When NOT to migrate

Two cases keep `db push` worthwhile:

- **Spinning up a fresh dev database from scratch**: faster than
  applying ~30 migrations in sequence. Just remember to delete the
  resulting database before rejoining the migration flow.
- **Prototyping a new field that may be reverted in the same day**:
  flip the schema, push, test. Don't commit until the design lands —
  then write a single migration for the final shape.

In both cases the `npm run db:push` script is still available; the
migration scripts (`db:migrate:dev`, `db:migrate:deploy`,
`db:migrate:status`, `db:migrate:resolve`) are simply additions, not
replacements.
