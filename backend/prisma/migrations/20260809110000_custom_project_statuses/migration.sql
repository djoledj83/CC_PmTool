-- Custom project statuses. Convert Project.status and ChangeRequest.status
-- from the ProjectStatus enum to a free TEXT column so admins can define
-- their own workflow states via the StatusOption table (scope PROJECT).
-- Existing values are preserved as their string form. The ProjectStatus
-- enum TYPE is intentionally kept (still declared in schema.prisma) as the
-- canonical list of the six built-in keys that carry special code
-- semantics and as the runtime reference used by lib/schemaEnums.js.
ALTER TABLE "Project" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Project" ALTER COLUMN "status" TYPE TEXT USING "status"::text;
ALTER TABLE "Project" ALTER COLUMN "status" SET DEFAULT 'TODO';

ALTER TABLE "ChangeRequest" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ChangeRequest" ALTER COLUMN "status" TYPE TEXT USING "status"::text;
ALTER TABLE "ChangeRequest" ALTER COLUMN "status" SET DEFAULT 'TODO';
