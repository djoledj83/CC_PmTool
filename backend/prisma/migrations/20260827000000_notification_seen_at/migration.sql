-- Two-stage notification state. `seenAt` is stamped when the bell dropdown
-- is opened (this drives the badge count), while `read` still only flips
-- when the user clicks an individual notification (this drives the bold /
-- highlight styling). Existing rows that are already read count as seen.
ALTER TABLE "Notification" ADD COLUMN "seenAt" TIMESTAMP(3);

UPDATE "Notification" SET "seenAt" = COALESCE("readAt", "createdAt") WHERE "read" = true;

CREATE INDEX "Notification_userId_seenAt_idx" ON "Notification"("userId", "seenAt");
