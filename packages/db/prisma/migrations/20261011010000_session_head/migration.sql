-- The writer keeps each session's newest entry on its row, so an append reads its parent from the
-- row it locks. Readers still take the head as the entry with the highest seq. Guarded to rerun.

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "headEntryId" TEXT;

UPDATE "sessions" AS s
SET "headEntryId" = (
    SELECT e."id" FROM "session_entries" AS e
    WHERE e."sessionId" = s."id"
    ORDER BY e."seq" DESC
    LIMIT 1
)
WHERE s."headEntryId" IS NULL AND s."nextEntrySeq" > 0;
