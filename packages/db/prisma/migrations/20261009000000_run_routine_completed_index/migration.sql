-- CreateIndex
CREATE INDEX "runs_routineId_completedAt_idx" ON "runs"("routineId", "completedAt");
