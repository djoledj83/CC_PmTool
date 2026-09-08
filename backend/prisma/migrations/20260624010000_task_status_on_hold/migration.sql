-- Add an "On hold" task status. Display order is controlled in the UI
-- (TASK_STATUSES), so the enum's internal sort order is irrelevant.
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'ON_HOLD';
