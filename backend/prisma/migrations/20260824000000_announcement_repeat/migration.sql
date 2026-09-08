-- Recurring announcements: re-show every N days until an optional end date.
ALTER TABLE "Announcement" ADD COLUMN "repeatIntervalDays" INTEGER;
ALTER TABLE "Announcement" ADD COLUMN "repeatUntil" TIMESTAMP(3);
