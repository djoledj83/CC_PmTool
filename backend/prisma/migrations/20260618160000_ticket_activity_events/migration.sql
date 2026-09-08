-- Ticket actions in the activity feed. Additive enum values only; no
-- data change. Each ADD VALUE is idempotent so re-running is safe.

ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'TICKET_CREATED';
ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'TICKET_STATUS_CHANGED';
ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'TICKET_ASSIGNED';
ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'TICKET_DELETED';
