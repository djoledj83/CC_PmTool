-- Notification fired when a new ticket is opened (sent to agents).
-- Additive enum value; no data change.

ALTER TYPE "NotificationType" ADD VALUE 'TICKET_CREATED';
