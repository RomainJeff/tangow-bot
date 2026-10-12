-- The session log replaces the messages table. scripts/backfill-session-log.ts writes every
-- thread's messages to its main session before this runs, each message's first entry keeping the
-- message's id, so what pointed at a message now points at that entry. Guarded to rerun.

-- Refuse to drop a message the log does not hold: a thread with messages and no entries has not
-- been backfilled. This runs first, so a refusal changes nothing.
-- The inner check is planned only once the table is known to exist, so a rerun passes.
DO $$
BEGIN
  IF to_regclass('public.messages') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM "messages" AS m
      JOIN "threads" AS t ON t."id" = m."threadId"
      WHERE NOT EXISTS (SELECT 1 FROM "session_entries" AS e WHERE e."sessionId" = t."sessionId")
    ) THEN
      RAISE EXCEPTION 'Threads still hold messages the session log does not: run scripts/backfill-session-log.ts, which backfills them and applies this migration.';
    END IF;
  END IF;
END $$;

-- What pointed at a message the backfill gave no entry follows the old delete rules.
UPDATE "runs" SET "sourceMessageId" = NULL
WHERE "sourceMessageId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "session_entries" AS e WHERE e."id" = "runs"."sourceMessageId");
DELETE FROM "steering_messages"
WHERE NOT EXISTS (SELECT 1 FROM "session_entries" AS e WHERE e."id" = "steering_messages"."messageId");
UPDATE "external_messages" SET "threadMessageId" = NULL
WHERE "threadMessageId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "session_entries" AS e WHERE e."id" = "external_messages"."threadMessageId"
  );
UPDATE "artifacts" SET "previewMessageId" = NULL
WHERE "previewMessageId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "session_entries" AS e WHERE e."id" = "artifacts"."previewMessageId");

-- AddForeignKey
ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_sourceMessageId_fkey";
ALTER TABLE "runs" ADD CONSTRAINT "runs_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "session_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "steering_messages" DROP CONSTRAINT IF EXISTS "steering_messages_messageId_fkey";
ALTER TABLE "steering_messages" ADD CONSTRAINT "steering_messages_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "session_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "external_messages" DROP CONSTRAINT IF EXISTS "external_messages_threadMessageId_fkey";
ALTER TABLE "external_messages" ADD CONSTRAINT "external_messages_threadMessageId_fkey" FOREIGN KEY ("threadMessageId") REFERENCES "session_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "artifacts_previewMessageId_fkey";
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_previewMessageId_fkey" FOREIGN KEY ("previewMessageId") REFERENCES "session_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The feed events the log's own events replaced name messages that are gone.
DELETE FROM "events" WHERE "type" IN (
  'thread.message.created',
  'thread.message.updated',
  'thread.subagent',
  'thread.cleared',
  'thread.rewound',
  'agent.tool.called',
  'run.waiting_input'
);

-- DropTable
DROP TABLE IF EXISTS "messages";

-- AlterTable
ALTER TABLE "threads" DROP COLUMN IF EXISTS "nextMessageSeq";
ALTER TABLE "threads" DROP COLUMN IF EXISTS "historyCompactedUpToSeq";
ALTER TABLE "threads" DROP COLUMN IF EXISTS "historyCompactionSummary";
ALTER TABLE "threads" DROP COLUMN IF EXISTS "historyCompactionGeneration";
