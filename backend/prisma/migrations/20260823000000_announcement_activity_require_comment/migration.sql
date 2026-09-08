-- Mandatory written response option for announcements.
ALTER TABLE "Announcement" ADD COLUMN "requireComment" BOOLEAN NOT NULL DEFAULT false;

-- Activity-feed event types for announcement actions (PG12+; project runs PG16).
ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'ANNOUNCEMENT_CREATED';
ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'ANNOUNCEMENT_ACTIVATED';
ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'ANNOUNCEMENT_DEACTIVATED';
ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'ANNOUNCEMENT_DELETED';
ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'ANNOUNCEMENT_ACKNOWLEDGED';
