-- A routine session holds one routine run's own entries. It belongs to the thread session the
-- routine reports to, and has no thread and no launching entry. Guarded to rerun. The file runs as
-- one transaction, so the exclusive lock the DROP and ADD take holds through the validation scan
-- and writers wait for it; acceptable while the sessions table is small.
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_kind_shape_check";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_kind_shape_check" CHECK (
    ("kind" = 'thread' AND "threadId" IS NOT NULL AND "parentSessionId" IS NULL AND "parentEntryId" IS NULL)
    OR ("kind" = 'subagent' AND "threadId" IS NULL AND "parentSessionId" IS NOT NULL AND "parentEntryId" IS NOT NULL)
    OR ("kind" = 'routine' AND "threadId" IS NULL AND "parentSessionId" IS NOT NULL AND "parentEntryId" IS NULL)
) NOT VALID;
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_kind_shape_check";
