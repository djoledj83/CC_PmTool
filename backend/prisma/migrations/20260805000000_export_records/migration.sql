-- Saved export snapshots (time-tracking CSVs today). Each row points at a
-- stored file under uploads/exports and is pruned after expiresAt.
CREATE TABLE "ExportRecord" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TIME_CSV',
    "filename" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "rowCount" INTEGER,
    "meta" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExportRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExportRecord_kind_createdAt_idx" ON "ExportRecord"("kind", "createdAt");
CREATE INDEX "ExportRecord_createdById_idx" ON "ExportRecord"("createdById");
CREATE INDEX "ExportRecord_expiresAt_idx" ON "ExportRecord"("expiresAt");

ALTER TABLE "ExportRecord" ADD CONSTRAINT "ExportRecord_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
