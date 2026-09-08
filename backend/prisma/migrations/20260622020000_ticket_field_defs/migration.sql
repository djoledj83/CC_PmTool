-- Global, admin-defined extra fields for the raise-ticket form.
-- TERMINAL / CLIENT = built-in pickers; TEXT = name/value; SELECT =
-- multi-select whose choices live in "options".

CREATE TYPE "TicketFieldType" AS ENUM ('TERMINAL', 'CLIENT', 'TEXT', 'SELECT');

CREATE TABLE "TicketFieldDef" (
    "id" TEXT NOT NULL,
    "type" "TicketFieldType" NOT NULL,
    "label" TEXT NOT NULL,
    "options" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TicketFieldDef_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TicketFieldDef_position_idx" ON "TicketFieldDef"("position");
