-- Switch the time-log policy from a fixed date range to a recurring
-- monthly model: a cutoff (deadline) day of the month and a reminder
-- lead time. The required day count is now computed from the working
-- days (Mon-Fri) of the enforced month, so `requiredDays`/`startDate`/
-- `endDate` become unused (left in place for historical continuity).
ALTER TABLE "TimeLogPolicy" ADD COLUMN "cutoffDay" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "TimeLogPolicy" ADD COLUMN "reminderLeadDays" INTEGER NOT NULL DEFAULT 7;
