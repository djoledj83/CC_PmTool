-- Per-user "must keep the working log filled" flag + a date marker used
-- to send at most one reminder notification per day.
ALTER TABLE "User" ADD COLUMN "timeLogMandatory" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "lastTimeLogNotifiedOn" TIMESTAMP(3);

-- Singleton policy row (id = 'singleton') holding the admin config.
CREATE TABLE "TimeLogPolicy" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "requiredDays" INTEGER NOT NULL DEFAULT 20,
    "minHoursPerDay" DOUBLE PRECISION NOT NULL DEFAULT 6,
    "notify" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    CONSTRAINT "TimeLogPolicy_pkey" PRIMARY KEY ("id")
);

-- New notification type for the reminder. IF NOT EXISTS keeps re-runs safe
-- (PostgreSQL 12+; the project runs PG16).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TIME_LOG_REMINDER';
