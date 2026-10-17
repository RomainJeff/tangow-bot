ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_kind_shape_check";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_kind_shape_check" CHECK (
    ("kind" = 'thread' AND "threadId" IS NOT NULL AND "parentSessionId" IS NULL AND "parentEntryId" IS NULL)
    OR ("kind" = 'subagent' AND "threadId" IS NULL AND "parentSessionId" IS NOT NULL AND "parentEntryId" IS NOT NULL)
    OR ("kind" = 'routine' AND "threadId" IS NULL AND "parentSessionId" IS NOT NULL AND "parentEntryId" IS NULL)
    OR ("kind" = 'interactive' AND "threadId" IS NULL AND "parentSessionId" IS NOT NULL AND "parentEntryId" IS NOT NULL)
) NOT VALID;
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_kind_shape_check";
