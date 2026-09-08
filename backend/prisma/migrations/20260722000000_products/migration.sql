-- Admin-managed Product catalogue + project link (projects now pick a
-- Product instead of an Application; existing applicationId links are left
-- untouched).
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Product_isActive_idx" ON "Product"("isActive");

ALTER TABLE "Project" ADD COLUMN "productId" TEXT;

CREATE INDEX "Project_productId_idx" ON "Project"("productId");

ALTER TABLE "Project" ADD CONSTRAINT "Project_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
