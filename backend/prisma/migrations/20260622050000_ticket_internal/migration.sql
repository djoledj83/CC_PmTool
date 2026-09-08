-- Internal tickets are private to their reporter / assignee / selected
-- participants (plus admins); external (default) behave like all others.

ALTER TABLE "Ticket" ADD COLUMN "internal" BOOLEAN NOT NULL DEFAULT false;
