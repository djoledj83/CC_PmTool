-- Per-user planned hours on a planning sprint (mirror of SprintCapacity
-- for the cross-project board's capacity heatmap). Purely additive.
CREATE TABLE "PlanningSprintCapacity" (
    "planningSprintId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plannedHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanningSprintCapacity_pkey" PRIMARY KEY ("planningSprintId", "userId")
);

CREATE INDEX "PlanningSprintCapacity_userId_idx" ON "PlanningSprintCapacity"("userId");

ALTER TABLE "PlanningSprintCapacity"
    ADD CONSTRAINT "PlanningSprintCapacity_planningSprintId_fkey"
    FOREIGN KEY ("planningSprintId") REFERENCES "PlanningSprint"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlanningSprintCapacity"
    ADD CONSTRAINT "PlanningSprintCapacity_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
