-- Request types are no longer tied to a project: the requester picks the
-- project when raising a ticket. Make TicketRequestType.projectId
-- optional and switch its FK to SET NULL (a deleted project just clears
-- the soft hint instead of being blocked). Additive / non-destructive.

ALTER TABLE "TicketRequestType" ALTER COLUMN "projectId" DROP NOT NULL;

ALTER TABLE "TicketRequestType" DROP CONSTRAINT "TicketRequestType_projectId_fkey";

ALTER TABLE "TicketRequestType" ADD CONSTRAINT "TicketRequestType_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
