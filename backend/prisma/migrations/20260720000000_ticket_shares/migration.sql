-- Read-only "shared with" grants for tickets. Lets a recipient open a
-- ticket they'd otherwise not be allowed to see, without enrolling them
-- as a participant (i.e. without subscribing them to every message).
CREATE TABLE "TicketShare" (
    "ticketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sharedById" TEXT,
    "sharedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketShare_pkey" PRIMARY KEY ("ticketId","userId")
);

CREATE INDEX "TicketShare_userId_idx" ON "TicketShare"("userId");

ALTER TABLE "TicketShare" ADD CONSTRAINT "TicketShare_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TicketShare" ADD CONSTRAINT "TicketShare_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TicketShare" ADD CONSTRAINT "TicketShare_sharedById_fkey"
    FOREIGN KEY ("sharedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
