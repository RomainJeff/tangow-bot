-- The session log replaces the messages table. Each message lives on an entry of its own id once
-- scripts/backfill-session-log.ts (the migrate service) or the API at start has moved it, so what
-- pointed at a message now points at that entry.
--
-- drop_messages_when_logged() drops the table only when every message is held that way and is a
-- no-op otherwise, so this migration never fails: an install that still runs `prisma migrate
-- deploy` before the API keeps starting, and the API then moves the messages and calls it again.
-- It holds every writer off `messages` from the check to the drop, so no row lands in between.
CREATE OR REPLACE FUNCTION drop_messages_when_logged() RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('public.messages') IS NULL THEN
    RETURN true;
  END IF;
  LOCK TABLE "messages" IN EXCLUSIVE MODE;
  IF EXISTS (
    SELECT 1 FROM "messages" AS m
    WHERE NOT EXISTS (SELECT 1 FROM "session_entries" AS e WHERE e."id" = m."id")
  ) THEN
    RETURN false;
  END IF;

  -- The feed events the log's own events replaced name messages that are gone. Deleted before
  -- the constraints below, whose locks would otherwise wait out this scan.
  DELETE FROM "events" WHERE "type" IN (
    'thread.message.created',
    'thread.message.updated',
    'thread.subagent',
    'thread.cleared',
    'thread.rewound',
    'agent.tool.called',
    'run.waiting_input'
  );

  ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_sourceMessageId_fkey";
  ALTER TABLE "runs" ADD CONSTRAINT "runs_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "session_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  ALTER TABLE "steering_messages" DROP CONSTRAINT IF EXISTS "steering_messages_messageId_fkey";
  ALTER TABLE "steering_messages" ADD CONSTRAINT "steering_messages_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "session_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "external_messages" DROP CONSTRAINT IF EXISTS "external_messages_threadMessageId_fkey";
  ALTER TABLE "external_messages" ADD CONSTRAINT "external_messages_threadMessageId_fkey" FOREIGN KEY ("threadMessageId") REFERENCES "session_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "artifacts_previewMessageId_fkey";
  ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_previewMessageId_fkey" FOREIGN KEY ("previewMessageId") REFERENCES "session_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

  DROP TABLE "messages";

  ALTER TABLE "threads" DROP COLUMN IF EXISTS "nextMessageSeq";
  ALTER TABLE "threads" DROP COLUMN IF EXISTS "historyCompactedUpToSeq";
  ALTER TABLE "threads" DROP COLUMN IF EXISTS "historyCompactionSummary";
  ALTER TABLE "threads" DROP COLUMN IF EXISTS "historyCompactionGeneration";
  RETURN true;
END $$;

SELECT drop_messages_when_logged();
