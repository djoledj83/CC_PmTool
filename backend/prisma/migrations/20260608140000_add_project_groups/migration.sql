-- Admin-defined project groups (many-to-many with projects). Additive.
CREATE TABLE "ProjectGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectGroupMembership" (
    "groupId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectGroupMembership_pkey" PRIMARY KEY ("groupId", "projectId")
);

CREATE INDEX "ProjectGroupMembership_projectId_idx" ON "ProjectGroupMembership"("projectId");

ALTER TABLE "ProjectGroup"
    ADD CONSTRAINT "ProjectGroup_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProjectGroupMembership"
    ADD CONSTRAINT "ProjectGroupMembership_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "ProjectGroup"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectGroupMembership"
    ADD CONSTRAINT "ProjectGroupMembership_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
