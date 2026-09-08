-- Ticket attachments: files uploaded against a ticket by the requester
-- or an agent. Cascades with the ticket; uploader is nulled if the user
-- is deleted (authorship-as-history stance).

CREATE TABLE "TicketAttachment" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "uploaderId" TEXT,
    "filename" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mime" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TicketAttachment_ticketId_createdAt_idx"
    ON "TicketAttachment"("ticketId", "createdAt");

ALTER TABLE "TicketAttachment"
    ADD CONSTRAINT "TicketAttachment_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TicketAttachment"
    ADD CONSTRAINT "TicketAttachment_uploaderId_fkey"
    FOREIGN KEY ("uploaderId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
