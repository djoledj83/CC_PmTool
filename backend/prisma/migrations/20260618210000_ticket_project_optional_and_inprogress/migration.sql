-- Tickets can now be opened without a project (the requester no longer
-- picks one — a resolver assigns it later). Make projectId nullable and
-- switch the FK to SET NULL.

ALTER TABLE "Ticket" ALTER COLUMN "projectId" DROP NOT NULL;

ALTER TABLE "Ticket" DROP CONSTRAINT IF EXISTS "Ticket_projectId_fkey";

ALTER TABLE "Ticket"
    ADD CONSTRAINT "Ticket_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
