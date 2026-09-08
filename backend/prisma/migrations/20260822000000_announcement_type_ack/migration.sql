-- Announcement severity/type + whether it needs acknowledgement.
--   type: IMPORTANT (red) | INFO (green) | TIP (orange)
--   requireAck=false → informational only (modal just has a Close button)
ALTER TABLE "Announcement" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'INFO';
ALTER TABLE "Announcement" ADD COLUMN "requireAck" BOOLEAN NOT NULL DEFAULT true;
