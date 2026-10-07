-- The help panel next to the "Raise new ticket" form moves onto each
-- ticket type: related resources + the on-call contact (tips are already
-- per type). The old global "Raise-ticket help" row is copied onto every
-- type, so requesters see exactly what they saw before; the
-- "TicketHelpSettings" table is left in place (no longer read).

ALTER TABLE "TicketRequestType" ADD COLUMN "resourcesIntro" TEXT;
ALTER TABLE "TicketRequestType" ADD COLUMN "resources" JSONB;
ALTER TABLE "TicketRequestType" ADD COLUMN "oncallText" TEXT;
ALTER TABLE "TicketRequestType" ADD COLUMN "oncallLabel" TEXT;
ALTER TABLE "TicketRequestType" ADD COLUMN "oncallContact" TEXT;

-- Until now an empty / missing tips list meant "use the default tips".
-- Normalise those to NULL first ...
UPDATE "TicketRequestType"
SET "tips" = NULL
WHERE "tips" IS NOT NULL
  AND (jsonb_typeof("tips") <> 'array' OR "tips" = '[]'::jsonb);

-- ... then copy the global settings (if they were ever saved). A type
-- keeps its own tips; one without gets the default list that was in
-- effect (still NULL = the built-in tips if none was saved).
UPDATE "TicketRequestType" AS t
SET "tips"           = COALESCE(t."tips", h."tips"),
    "resourcesIntro" = h."resourcesIntro",
    "resources"      = h."resources",
    "oncallText"     = h."oncallText",
    "oncallLabel"    = h."oncallLabel",
    "oncallContact"  = h."oncallContact"
FROM "TicketHelpSettings" AS h
WHERE h."id" = 'singleton';
