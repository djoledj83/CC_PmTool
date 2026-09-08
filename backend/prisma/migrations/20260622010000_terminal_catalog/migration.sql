-- Terminal catalog: vendors + models (each model carries its OS type).
-- Used later when raising tickets (Vendor -> Model -> OS).

CREATE TYPE "TerminalOS" AS ENUM ('LINUX', 'ANDROID');

CREATE TABLE "TerminalVendor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TerminalVendor_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TerminalVendor_name_idx" ON "TerminalVendor"("name");

CREATE TABLE "TerminalModel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "osType" "TerminalOS" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "vendorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TerminalModel_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TerminalModel_vendorId_idx" ON "TerminalModel"("vendorId");

ALTER TABLE "TerminalModel"
    ADD CONSTRAINT "TerminalModel_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "TerminalVendor"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
