-- Personal drag-sorted ordering of the Projects list (array of project
-- IDs). Nullable + additive.
ALTER TABLE "User" ADD COLUMN "projectOrder" JSONB;
