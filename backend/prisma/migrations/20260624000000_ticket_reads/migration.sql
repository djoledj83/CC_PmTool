-- Per-user read cursor for tickets, powering "Seen" receipts on messages.
CREATE TABLE "TicketRead" (
    "ticketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketRead_pkey" PRIMARY KEY ("ticketId","userId")
);

CREATE INDEX "TicketRead_userId_idx" ON "TicketRead"("userId");

ALTER TABLE "TicketRead" ADD CONSTRAINT "TicketRead_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TicketRead" ADD CONSTRAINT "TicketRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
