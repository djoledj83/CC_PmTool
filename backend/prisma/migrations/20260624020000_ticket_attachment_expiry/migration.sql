-- Image ticket attachments auto-expire (~2 months). Non-image files keep
-- expiresAt NULL and are retained indefinitely.
ALTER TABLE "TicketAttachment" ADD COLUMN "expiresAt" TIMESTAMP(3);

CREATE INDEX "TicketAttachment_expiresAt_idx" ON "TicketAttachment"("expiresAt");
