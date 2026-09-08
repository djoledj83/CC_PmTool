-- Soft-delete for tickets (auditable + restorable) instead of a hard
-- delete. Adds Ticket.deletedAt + index, and the audit enum value for the
-- restore event (TICKET_DELETED already exists).
ALTER TABLE "Ticket" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "Ticket_deletedAt_idx" ON "Ticket"("deletedAt");

ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'TICKET_RESTORED';
