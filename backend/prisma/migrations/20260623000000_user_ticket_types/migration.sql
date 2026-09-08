-- Which ticket request types an INTERNAL requester may raise. No rows for
-- a user = that internal requester can raise nothing until granted.

CREATE TABLE "UserTicketType" (
    "userId" TEXT NOT NULL,
    "requestTypeId" TEXT NOT NULL,
    CONSTRAINT "UserTicketType_pkey" PRIMARY KEY ("userId", "requestTypeId")
);

CREATE INDEX "UserTicketType_requestTypeId_idx" ON "UserTicketType"("requestTypeId");

ALTER TABLE "UserTicketType"
    ADD CONSTRAINT "UserTicketType_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserTicketType"
    ADD CONSTRAINT "UserTicketType_requestTypeId_fkey"
    FOREIGN KEY ("requestTypeId") REFERENCES "TicketRequestType"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
