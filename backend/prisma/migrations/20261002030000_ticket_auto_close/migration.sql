-- Auto-close resolved tickets: when resolving, an agent can choose to have
-- the ticket close by itself N days later. Swept by lib/ticketAutoClose.js.
ALTER TABLE "Ticket" ADD COLUMN "autoCloseAt" TIMESTAMP(3);
ALTER TABLE "Ticket" ADD COLUMN "autoCloseDays" INTEGER;

CREATE INDEX "Ticket_status_autoCloseAt_idx" ON "Ticket"("status", "autoCloseAt");

-- Timeline event for the automatic Resolved → Closed step.
ALTER TYPE "TicketEventKind" ADD VALUE IF NOT EXISTS 'AUTO_CLOSED';
