-- Authentication audit trail: one row per login attempt (success / failure /
-- blocked). Additive only; no data touched.
CREATE TABLE "AuthEvent" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuthEvent_email_idx" ON "AuthEvent"("email");
CREATE INDEX "AuthEvent_type_createdAt_idx" ON "AuthEvent"("type", "createdAt");
CREATE INDEX "AuthEvent_createdAt_idx" ON "AuthEvent"("createdAt");
