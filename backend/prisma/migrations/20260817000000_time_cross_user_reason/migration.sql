-- Time logged on a task assigned to someone else carries a reason
-- (category) and an optional note explaining why. Both nullable; null
-- for own-task and project-level entries.
ALTER TABLE "TimeEntry" ADD COLUMN "crossUserReason" TEXT;
ALTER TABLE "TimeEntry" ADD COLUMN "crossUserNote" TEXT;
