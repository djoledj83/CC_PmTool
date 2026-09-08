-- Soft-delete for projects (auditable + restorable) instead of a hard
-- delete. Adds Project.deletedAt + index, and the audit/notification enum
-- values for the delete/restore events.
ALTER TABLE "Project" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "Project_deletedAt_idx" ON "Project"("deletedAt");

ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'PROJECT_DELETED';
ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'PROJECT_RESTORED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PROJECT_RESTORED';
