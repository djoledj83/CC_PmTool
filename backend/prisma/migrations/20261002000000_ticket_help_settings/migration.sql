-- Raise-ticket help (singleton row, created on first save): self-help
-- resource links and the on-call contact shown next to the
-- "Raise new ticket" form.
CREATE TABLE "TicketHelpSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "resourcesIntro" TEXT,
    "resources" JSONB,
    "oncallText" TEXT,
    "oncallLabel" TEXT,
    "oncallContact" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "TicketHelpSettings_pkey" PRIMARY KEY ("id")
);
