-- T02: binding state for native sessions and their off-thread lifecycle journal.
-- Both tables are bot+thread carried from the start so ordinary bots (persistent or
-- future specialists) are covered before scoped_tasks exists (T04). scopedTaskId is
-- nullable and has no FK yet; only the FK to scoped_tasks.id is added in T04.
CREATE TABLE "native_sessions" (
  "id" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "scopedTaskId" TEXT,
  "harness" TEXT,
  "executionTarget" TEXT,
  "choiceVersion" INTEGER,
  "generation" INTEGER NOT NULL DEFAULT 0,
  "nativeRef" TEXT,
  "state" TEXT NOT NULL DEFAULT 'absent',
  "activeAttemptId" TEXT,
  "activeRunId" TEXT,
  "suspendedCallId" TEXT,
  "deliveredCursor" TEXT,
  "ackedCursor" TEXT,
  "appliedCursor" TEXT,
  "contextRevision" INTEGER NOT NULL DEFAULT 0,
  "processState" TEXT NOT NULL DEFAULT 'none',
  "processRef" TEXT,
  "confinedResidues" JSONB,
  "quiescenceCapability" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "native_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "native_sessions_botId_threadId_key" ON "native_sessions"("botId", "threadId");
CREATE UNIQUE INDEX "native_sessions_scopedTaskId_key" ON "native_sessions"("scopedTaskId");
CREATE UNIQUE INDEX "native_sessions_activeAttemptId_key" ON "native_sessions"("activeAttemptId");

CREATE TABLE "lifecycle_events" (
  "id" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "scopedTaskId" TEXT,
  "kind" TEXT NOT NULL,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "lifecycle_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lifecycle_events_botId_threadId_createdAt_idx" ON "lifecycle_events"("botId", "threadId", "createdAt");
CREATE INDEX "lifecycle_events_scopedTaskId_idx" ON "lifecycle_events"("scopedTaskId");
