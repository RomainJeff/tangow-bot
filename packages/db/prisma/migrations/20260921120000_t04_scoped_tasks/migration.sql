-- T04: delegation schema (PA-CONTRAT-CONVERGENCE.md §8, migration 2).
-- Thread.kind: backfilled from the existing carrier relation, then made NOT NULL.
-- kind=work is never produced by this backfill (no scoped_tasks exist yet); it is only
-- ever set going forward, by delegated-tasks.ts, for a thread it creates itself.
ALTER TABLE "threads" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'direct';

UPDATE "threads" SET "kind" = 'group' WHERE "groupId" IS NOT NULL;
UPDATE "threads" SET "kind" = 'external' WHERE "externalConversationId" IS NOT NULL;
-- Ambiguous rows (more than one carrier relation set) would collide with the checks
-- below; assert none exist rather than silently picking one.
DO $$
DECLARE
  ambiguous_count integer;
BEGIN
  SELECT count(*) INTO ambiguous_count
  FROM "threads"
  WHERE (CASE WHEN "botId" IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN "groupId" IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN "externalConversationId" IS NOT NULL THEN 1 ELSE 0 END) > 1;
  IF ambiguous_count > 0 THEN
    RAISE EXCEPTION 'T04 migration: % thread rows carry more than one of botId/groupId/externalConversationId', ambiguous_count;
  END IF;
END $$;

-- Bloquant J2 #1: threads_owner_chk (20260906120000) demands exactly one carrier for every
-- row, but a work thread (kind='work') is scoped by its ScopedTask, not by a
-- bot/group/external relation, and carries all three as NULL. Replace the constraint so a
-- work thread is required to have zero carriers, while every other kind keeps the original
-- exactly-one-carrier invariant. ADD CONSTRAINT itself validates all existing rows, so this
-- doubles as the guard against legacy data: a pre-existing kind='work' row with a carrier
-- set (impossible today: nothing produces kind='work' before this migration) or a
-- non-work row with zero carriers would fail the migration outright.
ALTER TABLE "threads" DROP CONSTRAINT "threads_owner_chk";
ALTER TABLE "threads" ADD CONSTRAINT "threads_owner_chk" CHECK (
  (
    "kind" = 'work'
    AND num_nonnulls("botId", "groupId", "externalConversationId") = 0
  )
  OR (
    "kind" <> 'work'
    AND num_nonnulls("botId", "groupId", "externalConversationId") = 1
  )
);

-- scoped_tasks: work identity and lifecycle ceiling (PA §3.2, minimal columns for
-- the first green + scenario 2; filiation kept, cancellation/cleanup left to later lots).
CREATE TABLE "scoped_tasks" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "coordinatorBotId" TEXT NOT NULL,
  "coordinatorThreadId" TEXT NOT NULL,
  "executorBotId" TEXT NOT NULL,
  "specialistThreadId" TEXT NOT NULL,
  "parentScopedTaskId" TEXT,
  "rootScopedTaskId" TEXT NOT NULL,
  "depth" INTEGER NOT NULL DEFAULT 0,
  "profileBotId" TEXT NOT NULL,
  "brief" TEXT NOT NULL,
  "harness" TEXT NOT NULL,
  "executionTarget" TEXT NOT NULL,
  "choiceVersion" INTEGER NOT NULL,
  "missionComputerId" TEXT,
  "delegationCeiling" JSONB NOT NULL,
  "spawnKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'created',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "scoped_tasks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "scoped_tasks_specialistThreadId_key" ON "scoped_tasks"("specialistThreadId");
CREATE UNIQUE INDEX "scoped_tasks_spaceId_spawnKey_key" ON "scoped_tasks"("spaceId", "spawnKey");
CREATE INDEX "scoped_tasks_coordinatorBotId_status_idx" ON "scoped_tasks"("coordinatorBotId", "status");
CREATE INDEX "scoped_tasks_parentScopedTaskId_idx" ON "scoped_tasks"("parentScopedTaskId");
CREATE INDEX "scoped_tasks_rootScopedTaskId_status_idx" ON "scoped_tasks"("rootScopedTaskId", "status");

ALTER TABLE "scoped_tasks"
  ADD CONSTRAINT "scoped_tasks_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "scoped_tasks_coordinatorBotId_fkey" FOREIGN KEY ("coordinatorBotId") REFERENCES "bots"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "scoped_tasks_executorBotId_fkey" FOREIGN KEY ("executorBotId") REFERENCES "bots"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "scoped_tasks_specialistThreadId_fkey" FOREIGN KEY ("specialistThreadId") REFERENCES "threads"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "scoped_tasks_missionComputerId_fkey" FOREIGN KEY ("missionComputerId") REFERENCES "computers"("id") ON DELETE SET NULL;

-- T04:6: a mission Computer is shared by explicit right of use, never by transferring
-- Bot.computerId ownership from the specialist to the coordinator's Computer.
CREATE TABLE "computer_usage_grants" (
  "computerId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "computer_usage_grants_pkey" PRIMARY KEY ("computerId", "botId"),
  CONSTRAINT "computer_usage_grants_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "computers"("id") ON DELETE CASCADE,
  CONSTRAINT "computer_usage_grants_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE
);
CREATE INDEX "computer_usage_grants_botId_idx" ON "computer_usage_grants"("botId");

-- Run: delegation columns (PA §3.5). scopedTaskId nullable; no new Run status added.
ALTER TABLE "runs" ADD COLUMN "scopedTaskId" TEXT;
ALTER TABLE "runs" ADD COLUMN "terminalOutcome" TEXT;
ALTER TABLE "runs" ADD COLUMN "terminalReturnDelivery" TEXT;
CREATE INDEX "runs_scopedTaskId_idx" ON "runs"("scopedTaskId");
ALTER TABLE "runs"
  ADD CONSTRAINT "runs_scopedTaskId_fkey" FOREIGN KEY ("scopedTaskId") REFERENCES "scoped_tasks"("id") ON DELETE SET NULL;

-- Deferred FK from T02 (native_sessions/lifecycle_events.scopedTaskId), now that
-- scoped_tasks exists (PA §7/§8). Columns already exist and are nullable; only the
-- constraint is added here, nothing is recreated.
ALTER TABLE "native_sessions"
  ADD CONSTRAINT "native_sessions_scopedTaskId_fkey" FOREIGN KEY ("scopedTaskId") REFERENCES "scoped_tasks"("id") ON DELETE SET NULL;
ALTER TABLE "lifecycle_events"
  ADD CONSTRAINT "lifecycle_events_scopedTaskId_fkey" FOREIGN KEY ("scopedTaskId") REFERENCES "scoped_tasks"("id") ON DELETE SET NULL;

-- T04:2 finding 6: remaining contract columns, added nullable/empty rather than
-- rescheduled (coordinator's stated preference). None of these are written or read by
-- this lot's code; they exist so the contract's schema shape is complete for later lots
-- (T07 cancellation scheduling, native continuation, harness-choice bookkeeping).
ALTER TABLE "runs" ADD COLUMN "notBefore" TIMESTAMP(3);
ALTER TABLE "runs" ADD COLUMN "delegationCancelledAt" TIMESTAMP(3);
ALTER TABLE "attempts" ADD COLUMN "nativeGeneration" INTEGER;
ALTER TABLE "attempts" ADD COLUMN "executionPlanRef" TEXT;
ALTER TABLE "attempts" ADD COLUMN "turnAuthorizationId" TEXT;
ALTER TABLE "bots" ADD COLUMN "harnessChoice" TEXT;
ALTER TABLE "bots" ADD COLUMN "choiceVersion" INTEGER;
