-- The session log replaces the messages table. scripts/backfill-session-log.ts writes every
-- message to its thread's main session before this runs, each on an entry of the message's own id,
-- so what pointed at a message now points at that entry. Guarded to rerun.

-- Refuse to drop a message the log does not hold, and hold every writer off the table until the
-- drop, so none lands between the check and the drop. This runs first, so a refusal changes nothing.
-- The check is planned only once the table is known to exist, so a rerun passes.
DO $$
BEGIN
  IF to_regclass('public.messages') IS NOT NULL THEN
    LOCK TABLE "messages" IN EXCLUSIVE MODE;
    IF EXISTS (
      SELECT 1 FROM "messages" AS m
      WHERE NOT EXISTS (SELECT 1 FROM "session_entries" AS e WHERE e."id" = m."id")
    ) THEN
      RAISE EXCEPTION 'Threads still hold messages the session log does not: run scripts/backfill-session-log.ts, which backfills them and applies this migration.';
    END IF;
  END IF;
END $$;

-- The feed events the log's own events replaced name messages that are gone. Deleted before the
-- constraints below, whose locks would otherwise wait out this scan.
DELETE FROM "events" WHERE "type" IN (
  'thread.message.created',
  'thread.message.updated',
  'thread.subagent',
  'thread.cleared',
  'thread.rewound',
  'agent.tool.called',
  'run.waiting_input'
);

-- AddForeignKey
ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_sourceMessageId_fkey";
ALTER TABLE "runs" ADD CONSTRAINT "runs_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "session_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "steering_messages" DROP CONSTRAINT IF EXISTS "steering_messages_messageId_fkey";
ALTER TABLE "steering_messages" ADD CONSTRAINT "steering_messages_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "session_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "external_messages" DROP CONSTRAINT IF EXISTS "external_messages_threadMessageId_fkey";
ALTER TABLE "external_messages" ADD CONSTRAINT "external_messages_threadMessageId_fkey" FOREIGN KEY ("threadMessageId") REFERENCES "session_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "artifacts_previewMessageId_fkey";
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_previewMessageId_fkey" FOREIGN KEY ("previewMessageId") REFERENCES "session_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DropTable
DROP TABLE IF EXISTS "messages";

-- AlterTable
ALTER TABLE "threads" DROP COLUMN IF EXISTS "nextMessageSeq";
ALTER TABLE "threads" DROP COLUMN IF EXISTS "historyCompactedUpToSeq";
ALTER TABLE "threads" DROP COLUMN IF EXISTS "historyCompactionSummary";
ALTER TABLE "threads" DROP COLUMN IF EXISTS "historyCompactionGeneration";
