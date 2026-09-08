-- Disapproval workflow for "specific" tasks. An approver can reject a
-- specific task with a required reason instead of approving it. A rejected
-- task stays visible but locked (approvedAt still null). The creator can
-- re-request approval (clears these fields), and an approver can override
-- by approving (which clears them too). Adds the TASK_DISAPPROVED and
-- TASK_APPROVAL_REQUESTED audit event values.
ALTER TABLE "Task" ADD COLUMN "rejectedAt" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN "rejectedById" TEXT;
ALTER TABLE "Task" ADD COLUMN "rejectionReason" TEXT;

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_rejectedById_fkey"
  FOREIGN KEY ("rejectedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Task_rejectedById_idx" ON "Task"("rejectedById");

ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'TASK_DISAPPROVED';
ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'TASK_APPROVAL_REQUESTED';
