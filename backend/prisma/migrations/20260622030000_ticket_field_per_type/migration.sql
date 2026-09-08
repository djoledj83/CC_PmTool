-- A TicketFieldDef can belong to one ticket request type (per-type field)
-- or stay global (requestTypeId NULL = shown on every raise form).

ALTER TABLE "TicketFieldDef" ADD COLUMN "requestTypeId" TEXT;

CREATE INDEX "TicketFieldDef_requestTypeId_idx" ON "TicketFieldDef"("requestTypeId");

ALTER TABLE "TicketFieldDef"
    ADD CONSTRAINT "TicketFieldDef_requestTypeId_fkey"
    FOREIGN KEY ("requestTypeId") REFERENCES "TicketRequestType"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
