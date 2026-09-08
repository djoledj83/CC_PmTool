-- New ticket status: actively being worked on. Additive, idempotent.
ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'IN_PROGRESS';
