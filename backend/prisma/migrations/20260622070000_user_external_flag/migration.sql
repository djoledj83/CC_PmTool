-- Internal vs external requesters. Internal (default) = employee who sees
-- the whole shared queue; external = scoped to their organisation (client).

ALTER TABLE "User" ADD COLUMN "external" BOOLEAN NOT NULL DEFAULT false;
