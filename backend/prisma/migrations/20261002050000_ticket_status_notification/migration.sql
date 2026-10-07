-- Requesters hear when their ticket goes Pending / Resolved / Closed or is
-- reopened (lib/ticketStatusNotify.js).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TICKET_STATUS_CHANGED';
