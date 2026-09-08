-- Captured custom-field values on a ticket: client + terminal model as
-- references, free-text / multi-select values denormalised in JSON.

ALTER TABLE "Ticket" ADD COLUMN "clientId" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "terminalModelId" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "fieldValues" JSONB;

CREATE INDEX "Ticket_clientId_idx" ON "Ticket"("clientId");
CREATE INDEX "Ticket_terminalModelId_idx" ON "Ticket"("terminalModelId");

ALTER TABLE "Ticket"
    ADD CONSTRAINT "Ticket_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Ticket"
    ADD CONSTRAINT "Ticket_terminalModelId_fkey"
    FOREIGN KEY ("terminalModelId") REFERENCES "TerminalModel"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
