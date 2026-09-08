#!/usr/bin/env bash
# One-time cutover from `prisma db push` to `prisma migrate`.
# Bash twin of migrate-baseline.ps1 — see that file or
# docs/migrations.md for details. Run from the backend/ directory.
set -euo pipefail

if [ ! -f "prisma/schema.prisma" ]; then
    echo "Run this from the backend/ directory (prisma/schema.prisma not found)." >&2
    exit 1
fi

# Use the project's own Prisma CLI so the flags match the version the
# backend actually runs (a bare `npx prisma` can resolve to a newer
# major with renamed flags, e.g. --to-schema-datamodel -> --to-schema).
if [ -x "node_modules/.bin/prisma" ]; then
    PRISMA="node_modules/.bin/prisma"
else
    echo "Local Prisma not found — installing project deps first (npm install)..."
    npm install
    PRISMA="node_modules/.bin/prisma"
fi
echo "Using $($PRISMA --version | head -1)"

# Clean up empty *_init dirs left behind by previously failed runs.
for d in prisma/migrations/*_init; do
    [ -d "$d" ] || continue
    if [ ! -s "$d/migration.sql" ]; then
        echo "Removing leftover empty $d from a failed run"
        rm -rf "$d"
    fi
done

# Refuse to run twice: a populated init migration means we're done.
if ls prisma/migrations/*_init/migration.sql >/dev/null 2>&1; then
    echo "Baseline already exists: $(ls -d prisma/migrations/*_init). Nothing to do."
    exit 0
fi

stamp="$(date +%Y%m%d%H%M%S)"
dir="prisma/migrations/${stamp}_init"
mkdir -p "$dir"

echo "1/2 Generating baseline SQL -> $dir/migration.sql"
$PRISMA migrate diff \
    --from-empty \
    --to-schema-datamodel prisma/schema.prisma \
    --script > "$dir/migration.sql"

echo "2/2 Marking ${stamp}_init as applied on the target database"
$PRISMA migrate resolve --applied "${stamp}_init"

echo
echo "Done. Verify with: npm run db:migrate:status"
echo "Commit prisma/migrations/ (including migration_lock.toml) to git."
