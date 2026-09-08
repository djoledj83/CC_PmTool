-- Per-user UI theme preference ('light' | 'dark' | 'system'), synced
-- across devices. Additive + defaulted, so existing rows stay valid.
ALTER TABLE "User" ADD COLUMN "themePreference" TEXT NOT NULL DEFAULT 'system';
