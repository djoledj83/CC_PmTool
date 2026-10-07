-- "Tips for a good ticket" next to the raise form: the default list
-- (Raise-ticket help) and an optional per-ticket-type override.
-- JSON arrays of strings; NULL = not set.
ALTER TABLE "TicketHelpSettings" ADD COLUMN "tips" JSONB;
ALTER TABLE "TicketRequestType" ADD COLUMN "tips" JSONB;
