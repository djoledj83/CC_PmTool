-- Approval workflow for "specific" tasks. A specific task is locked
-- (can't leave TODO) until an approver signs off; approvedAt/approvedById
-- record the sign-off. Adds the TASK_APPROVED audit event value.
ALTER TABLE "Task" ADD COLUMN "specific" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Task" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN "approvedById" TEXT;

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Task_approvedById_idx" ON "Task"("approvedById");

ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'TASK_APPROVED';
