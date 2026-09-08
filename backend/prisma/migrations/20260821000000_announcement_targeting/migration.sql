-- Richer announcement targeting: besides ALL / INTERNAL / EXTERNAL, an
-- announcement can target specific roles, teams, or individual users.
ALTER TABLE "Announcement" ADD COLUMN "targetRoles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Announcement" ADD COLUMN "targetTeamIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Announcement" ADD COLUMN "targetUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Default mode is now ALL (was INTERNAL). Existing rows keep their value.
ALTER TABLE "Announcement" ALTER COLUMN "audience" SET DEFAULT 'ALL';
