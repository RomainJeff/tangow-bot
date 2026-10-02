-- Native harnesses and delegation: bot harness choice and the run snapshot of it, scoped
-- tasks with their specialist threads, native sessions and their lifecycle journal, mission
-- Computer usage grants, delegation limits and team chat relay provenance.

-- AlterTable
ALTER TABLE "deployment_settings" ADD COLUMN     "delegationMaxActiveSpecialists" INTEGER,
ADD COLUMN     "delegationMaxDepth" INTEGER;

-- AlterTable
ALTER TABLE "bots" ADD COLUMN     "choiceVersion" INTEGER,
ADD COLUMN     "harnessChoice" TEXT;

-- AlterTable
ALTER TABLE "threads" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'direct';

-- Thread kind is backfilled from the relation that carries each thread. No work thread
-- exists before this migration: kind = 'work' is only set going forward, for a thread
-- created with its scoped task.
UPDATE "threads" SET "kind" = 'group' WHERE "groupId" IS NOT NULL;
UPDATE "threads" SET "kind" = 'external' WHERE "externalConversationId" IS NOT NULL;

-- A thread carried by more than one relation would collide with the owner check below:
-- stop rather than silently pick one.
DO $$
DECLARE
  ambiguous_count integer;
BEGIN
  SELECT count(*) INTO ambiguous_count
  FROM "threads"
  WHERE num_nonnulls("botId", "groupId", "externalConversationId") > 1;
  IF ambiguous_count > 0 THEN
    RAISE EXCEPTION 'migration: % thread rows carry more than one of botId/groupId/externalConversationId', ambiguous_count;
  END IF;
END $$;

-- A work thread belongs to its scoped task and carries none of bot, group or external
-- conversation; every other kind keeps the exactly-one-carrier rule. Adding the constraint
-- also validates every existing row against it.
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

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "choiceVersion" INTEGER,
ADD COLUMN     "executionTarget" TEXT,
ADD COLUMN     "harness" TEXT,
ADD COLUMN     "scopedTaskId" TEXT,
ADD COLUMN     "terminalOutcome" TEXT,
ADD COLUMN     "terminalReturnDelivery" TEXT;

-- AlterTable
ALTER TABLE "computers" ADD COLUMN     "bootClaimStamp" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "external_messages" ADD COLUMN     "relayConversationKey" TEXT,
ADD COLUMN     "relaySenderId" TEXT;

-- CreateTable
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
    "harness" TEXT,
    "executionTarget" TEXT,
    "choiceVersion" INTEGER,
    "harnessSource" TEXT,
    "harnessFallbackCause" TEXT,
    "missionComputerId" TEXT,
    "delegationCeiling" JSONB NOT NULL,
    "spawnKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scoped_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "computer_usage_grants" (
    "computerId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "computer_usage_grants_pkey" PRIMARY KEY ("computerId","botId")
);

-- CreateTable
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
    "processState" TEXT NOT NULL DEFAULT 'none',
    "processRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "native_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lifecycle_events" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "scopedTaskId" TEXT,
    "kind" TEXT NOT NULL,
    "callId" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lifecycle_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scoped_tasks_specialistThreadId_key" ON "scoped_tasks"("specialistThreadId");

-- CreateIndex
CREATE INDEX "scoped_tasks_coordinatorBotId_status_idx" ON "scoped_tasks"("coordinatorBotId", "status");

-- CreateIndex
CREATE INDEX "scoped_tasks_parentScopedTaskId_idx" ON "scoped_tasks"("parentScopedTaskId");

-- CreateIndex
CREATE INDEX "scoped_tasks_rootScopedTaskId_status_idx" ON "scoped_tasks"("rootScopedTaskId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "scoped_tasks_spaceId_spawnKey_key" ON "scoped_tasks"("spaceId", "spawnKey");

-- CreateIndex
CREATE INDEX "computer_usage_grants_botId_idx" ON "computer_usage_grants"("botId");

-- CreateIndex
CREATE UNIQUE INDEX "native_sessions_scopedTaskId_key" ON "native_sessions"("scopedTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "native_sessions_activeAttemptId_key" ON "native_sessions"("activeAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "native_sessions_botId_threadId_key" ON "native_sessions"("botId", "threadId");

-- CreateIndex
CREATE INDEX "lifecycle_events_botId_threadId_createdAt_idx" ON "lifecycle_events"("botId", "threadId", "createdAt");

-- CreateIndex
CREATE INDEX "lifecycle_events_scopedTaskId_idx" ON "lifecycle_events"("scopedTaskId");

-- CreateIndex
CREATE INDEX "lifecycle_events_botId_threadId_callId_idx" ON "lifecycle_events"("botId", "threadId", "callId");

-- CreateIndex
CREATE INDEX "runs_scopedTaskId_idx" ON "runs"("scopedTaskId");

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_scopedTaskId_fkey" FOREIGN KEY ("scopedTaskId") REFERENCES "scoped_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoped_tasks" ADD CONSTRAINT "scoped_tasks_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoped_tasks" ADD CONSTRAINT "scoped_tasks_coordinatorBotId_fkey" FOREIGN KEY ("coordinatorBotId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoped_tasks" ADD CONSTRAINT "scoped_tasks_executorBotId_fkey" FOREIGN KEY ("executorBotId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoped_tasks" ADD CONSTRAINT "scoped_tasks_specialistThreadId_fkey" FOREIGN KEY ("specialistThreadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoped_tasks" ADD CONSTRAINT "scoped_tasks_missionComputerId_fkey" FOREIGN KEY ("missionComputerId") REFERENCES "computers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "computer_usage_grants" ADD CONSTRAINT "computer_usage_grants_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "computers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "computer_usage_grants" ADD CONSTRAINT "computer_usage_grants_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_sessions" ADD CONSTRAINT "native_sessions_scopedTaskId_fkey" FOREIGN KEY ("scopedTaskId") REFERENCES "scoped_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lifecycle_events" ADD CONSTRAINT "lifecycle_events_scopedTaskId_fkey" FOREIGN KEY ("scopedTaskId") REFERENCES "scoped_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A Run's native choice is all or nothing: Rakazo's own harness carries none of the three
-- columns, a native harness carries all of them.
ALTER TABLE "runs"
  ADD CONSTRAINT "runs_harness_choice_complete"
  CHECK (
    ("harness" IS NULL AND "executionTarget" IS NULL AND "choiceVersion" IS NULL)
    OR (
      "harness" IS NOT NULL
      AND "harness" IN ('codex-native', 'claude-native')
      AND "executionTarget" IS NOT NULL
      AND "choiceVersion" = 1
    )
  );

-- A scoped task records its choice by the same rule, and how the harness was chosen.
ALTER TABLE "scoped_tasks"
  ADD CONSTRAINT "scoped_tasks_harness_choice_complete"
  CHECK (
    ("harness" IS NULL AND "executionTarget" IS NULL AND "choiceVersion" IS NULL)
    OR (
      "harness" IS NOT NULL
      AND "harness" IN ('codex-native', 'claude-native')
      AND "executionTarget" IS NOT NULL
      AND "choiceVersion" = 1
    )
  ),
  ADD CONSTRAINT "scoped_tasks_harness_source_known"
  CHECK ("harnessSource" IS NULL OR "harnessSource" IN ('explicit', 'profile', 'judgment', 'fallback')),
  ADD CONSTRAINT "scoped_tasks_harness_fallback_cause_known"
  CHECK (
    "harnessFallbackCause" IS NULL
    OR (
      "harnessSource" = 'fallback'
      AND "harnessFallbackCause" IN (
        'no_provider', 'single_harness', 'timeout', 'aborted', 'error', 'invalid_answer'
      )
    )
  );

-- Only rows that record a callId are constrained, so the reservation insert can rely on
-- ON CONFLICT to make a retransmitted callId under the same binding a single operation.
-- Prisma cannot express a partial unique index in the schema.
CREATE UNIQUE INDEX "lifecycle_events_botId_threadId_callId_unique"
  ON "lifecycle_events"("botId", "threadId", "callId")
  WHERE "callId" IS NOT NULL;
