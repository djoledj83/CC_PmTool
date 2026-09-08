-- Link a Task back to the help-desk Ticket it was created from
-- (resolver's "Add as Task" action). NULL for ordinary tasks.

ALTER TABLE "Task" ADD COLUMN "sourceTicketId" TEXT;

CREATE INDEX "Task_sourceTicketId_idx" ON "Task"("sourceTicketId");

ALTER TABLE "Task"
    ADD CONSTRAINT "Task_sourceTicketId_fkey"
    FOREIGN KEY ("sourceTicketId") REFERENCES "Ticket"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
