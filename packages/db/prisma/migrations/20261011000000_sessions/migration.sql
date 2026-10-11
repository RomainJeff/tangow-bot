-- Session logs: sessions own identity and the seq counter, session_entries hold the entries.
-- Every statement is guarded so a rerun converges, including on a database where some threads
-- already have their main session.
-- Locks threads and runs exclusively through the backfill and index builds; run it at a quiet moment.

-- CreateTable
CREATE TABLE IF NOT EXISTS "sessions" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "threadId" TEXT,
    "parentSessionId" TEXT,
    "parentEntryId" TEXT,
    "nextEntrySeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "session_entries" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "parentId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "botId" TEXT,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_entries_pkey" PRIMARY KEY ("id")
);

-- A thread session belongs to its thread. A subagent session belongs to its parent session and
-- the entry that launched it, and has no thread.
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_kind_shape_check";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_kind_shape_check" CHECK (
    ("kind" = 'thread' AND "threadId" IS NOT NULL AND "parentSessionId" IS NULL AND "parentEntryId" IS NULL)
    OR ("kind" = 'subagent' AND "threadId" IS NULL AND "parentSessionId" IS NOT NULL AND "parentEntryId" IS NOT NULL)
);

-- AlterTable
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "sessionId" TEXT;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "sessionId" TEXT;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "parentRunId" TEXT;

-- Give every existing thread a main session, then point its runs at it.
UPDATE "threads" SET "sessionId" = gen_random_uuid()::text WHERE "sessionId" IS NULL;

INSERT INTO "sessions" ("id", "spaceId", "kind", "threadId", "createdAt")
SELECT t."sessionId", t."spaceId", 'thread', t."id", t."createdAt"
FROM "threads" AS t
ON CONFLICT ("id") DO NOTHING;

UPDATE "runs" AS r
SET "sessionId" = t."sessionId"
FROM "threads" AS t
WHERE r."threadId" = t."id" AND r."sessionId" IS NULL;

ALTER TABLE "threads" ALTER COLUMN "sessionId" SET DEFAULT (gen_random_uuid())::text;
ALTER TABLE "threads" ALTER COLUMN "sessionId" SET NOT NULL;
ALTER TABLE "runs" ALTER COLUMN "sessionId" SET NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sessions_threadId_idx" ON "sessions"("threadId");
CREATE INDEX IF NOT EXISTS "sessions_parentSessionId_idx" ON "sessions"("parentSessionId");
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_threadId_main_key" ON "sessions"("threadId") WHERE "kind" = 'thread';
CREATE UNIQUE INDEX IF NOT EXISTS "session_entries_sessionId_seq_key" ON "session_entries"("sessionId", "seq");
CREATE INDEX IF NOT EXISTS "session_entries_sessionId_type_seq_idx" ON "session_entries"("sessionId", "type", "seq");
CREATE INDEX IF NOT EXISTS "session_entries_runId_seq_idx" ON "session_entries"("runId", "seq");
CREATE UNIQUE INDEX IF NOT EXISTS "threads_sessionId_key" ON "threads"("sessionId");
CREATE INDEX IF NOT EXISTS "runs_sessionId_idx" ON "runs"("sessionId");
CREATE INDEX IF NOT EXISTS "runs_parentRunId_idx" ON "runs"("parentRunId");

-- A redelivered message carries the clientNonce of its first delivery and keeps one entry.
-- Prisma cannot declare an expression index.
CREATE UNIQUE INDEX IF NOT EXISTS "session_entries_sessionId_clientNonce_key"
ON "session_entries"("sessionId", ("payload" ->> 'clientNonce'))
WHERE ("payload" ->> 'clientNonce') IS NOT NULL;

-- AddForeignKey
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_spaceId_fkey";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_spaceId_fkey";
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_threadId_fkey";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_threadId_fkey";
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_parentSessionId_fkey";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parentSessionId_fkey" FOREIGN KEY ("parentSessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_parentSessionId_fkey";
ALTER TABLE "session_entries" DROP CONSTRAINT IF EXISTS "session_entries_sessionId_fkey";
ALTER TABLE "session_entries" ADD CONSTRAINT "session_entries_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "session_entries" VALIDATE CONSTRAINT "session_entries_sessionId_fkey";
ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_sessionId_fkey";
ALTER TABLE "runs" ADD CONSTRAINT "runs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "runs" VALIDATE CONSTRAINT "runs_sessionId_fkey";
ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_parentRunId_fkey";
ALTER TABLE "runs" ADD CONSTRAINT "runs_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "runs" VALIDATE CONSTRAINT "runs_parentRunId_fkey";

-- Every thread gets its main session in the statement that inserts it, whichever writer that is.
CREATE OR REPLACE FUNCTION create_thread_main_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "sessions" ("id", "spaceId", "kind", "threadId", "createdAt")
  VALUES (NEW."sessionId", NEW."spaceId", 'thread', NEW."id", NEW."createdAt");
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "threads_create_main_session" ON "threads";
CREATE TRIGGER "threads_create_main_session" AFTER INSERT ON "threads"
FOR EACH ROW EXECUTE FUNCTION create_thread_main_session();

-- A run that names no session writes to its thread's main session.
CREATE OR REPLACE FUNCTION default_run_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT "sessionId" INTO NEW."sessionId" FROM "threads" WHERE "id" = NEW."threadId";
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "runs_default_session" ON "runs";
CREATE TRIGGER "runs_default_session" BEFORE INSERT ON "runs"
FOR EACH ROW WHEN (NEW."sessionId" IS NULL) EXECUTE FUNCTION default_run_session();
