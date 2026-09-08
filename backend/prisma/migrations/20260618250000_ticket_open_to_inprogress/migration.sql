-- "Open" is retired as a selectable ticket status (the set is now
-- New / In progress / Pending / Resolved / Closed). Move any existing
-- OPEN tickets to IN_PROGRESS so none are stuck on a hidden status.
-- The enum value itself is left in place for backward compatibility.
UPDATE "Ticket" SET "status" = 'IN_PROGRESS' WHERE "status" = 'OPEN';
