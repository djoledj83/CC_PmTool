-- Mandatory "service migration" announcement: a non-dismissible modal whose
-- only action redirects the user to a new address. The address is stored per
-- announcement in `redirectUrl` (null for every non-mandatory type). The
-- MANDATORY kind itself is app-level (the `type` column is a plain String),
-- so no enum change is required.
ALTER TABLE "Announcement" ADD COLUMN "redirectUrl" TEXT;
