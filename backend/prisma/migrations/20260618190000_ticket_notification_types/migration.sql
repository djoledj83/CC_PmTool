-- New notification types for ticket conversation + assignment. Additive
-- enum values; idempotent so re-running is safe.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TICKET_COMMENT';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TICKET_ASSIGNED';
