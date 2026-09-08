-- Which ticket request types a client's external users may raise on the
-- portal. No rows for a client = that client's external users see no types.

CREATE TABLE "ClientTicketType" (
    "clientId" TEXT NOT NULL,
    "requestTypeId" TEXT NOT NULL,
    CONSTRAINT "ClientTicketType_pkey" PRIMARY KEY ("clientId", "requestTypeId")
);

CREATE INDEX "ClientTicketType_requestTypeId_idx" ON "ClientTicketType"("requestTypeId");

ALTER TABLE "ClientTicketType"
    ADD CONSTRAINT "ClientTicketType_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClientTicketType"
    ADD CONSTRAINT "ClientTicketType_requestTypeId_fkey"
    FOREIGN KEY ("requestTypeId") REFERENCES "TicketRequestType"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
