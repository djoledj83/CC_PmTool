-- Broadcast announcements + per-user acknowledgements.
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'INTERNAL',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnnouncementAck" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "comment" TEXT,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnnouncementAck_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Announcement_active_idx" ON "Announcement"("active");
CREATE INDEX "AnnouncementAck_userId_idx" ON "AnnouncementAck"("userId");
CREATE UNIQUE INDEX "AnnouncementAck_announcementId_userId_key" ON "AnnouncementAck"("announcementId", "userId");

ALTER TABLE "Announcement"
    ADD CONSTRAINT "Announcement_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AnnouncementAck"
    ADD CONSTRAINT "AnnouncementAck_announcementId_fkey"
    FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnnouncementAck"
    ADD CONSTRAINT "AnnouncementAck_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
