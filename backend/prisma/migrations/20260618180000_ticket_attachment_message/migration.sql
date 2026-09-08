-- Allow a ticket attachment to belong to a specific message (a comment's
-- attachment). Nullable: existing rows + ticket-level uploads stay null.
-- On message delete the file falls back to a ticket-level record.

ALTER TABLE "TicketAttachment" ADD COLUMN "messageId" TEXT;

CREATE INDEX "TicketAttachment_messageId_idx"
    ON "TicketAttachment"("messageId");

ALTER TABLE "TicketAttachment"
    ADD CONSTRAINT "TicketAttachment_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "TicketMessage"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
