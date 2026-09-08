-- Coded fields for the logged-time export:
--   * ProjectTypeOption.activityCode  (activity/accounting code per type)
--   * User.employeeCode               (payroll code per employee)
--   * Entity catalogue + Project.entityId (billing entity per project)

ALTER TABLE "ProjectTypeOption" ADD COLUMN "activityCode" TEXT;

ALTER TABLE "User" ADD COLUMN "employeeCode" TEXT;

CREATE TABLE "Entity" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Entity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Entity_isActive_idx" ON "Entity"("isActive");

ALTER TABLE "Project" ADD COLUMN "entityId" TEXT;

CREATE INDEX "Project_entityId_idx" ON "Project"("entityId");

ALTER TABLE "Project" ADD CONSTRAINT "Project_entityId_fkey"
    FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
