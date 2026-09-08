-- Allowed agents per ticket request type. Empty set = unrestricted
-- (every agent sees the open queue). Non-empty = private team queue.

CREATE TABLE "TicketRequestTypeAgent" (
    "requestTypeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "TicketRequestTypeAgent_pkey" PRIMARY KEY ("requestTypeId", "userId")
);

CREATE INDEX "TicketRequestTypeAgent_userId_idx"
    ON "TicketRequestTypeAgent"("userId");

ALTER TABLE "TicketRequestTypeAgent"
    ADD CONSTRAINT "TicketRequestTypeAgent_requestTypeId_fkey"
    FOREIGN KEY ("requestTypeId") REFERENCES "TicketRequestType"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TicketRequestTypeAgent"
    ADD CONSTRAINT "TicketRequestTypeAgent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
