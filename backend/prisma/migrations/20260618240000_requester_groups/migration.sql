-- Admin-defined requester groups; a requester can add a whole group as
-- ticket participants at once.

CREATE TABLE "RequesterGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RequesterGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RequesterGroupMember" (
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "RequesterGroupMember_pkey" PRIMARY KEY ("groupId", "userId")
);

CREATE INDEX "RequesterGroupMember_userId_idx"
    ON "RequesterGroupMember"("userId");

ALTER TABLE "RequesterGroupMember"
    ADD CONSTRAINT "RequesterGroupMember_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "RequesterGroup"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RequesterGroupMember"
    ADD CONSTRAINT "RequesterGroupMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
