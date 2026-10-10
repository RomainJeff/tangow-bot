-- CreateIndex
CREATE INDEX IF NOT EXISTS "runs_routineId_completedAt_idx" ON "runs"("routineId", "completedAt");

-- DropIndex
DROP INDEX IF EXISTS "runs_routineId_idx";
