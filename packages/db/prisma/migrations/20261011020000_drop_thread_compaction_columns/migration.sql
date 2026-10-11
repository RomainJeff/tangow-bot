ALTER TABLE "threads" DROP COLUMN IF EXISTS "historyCompactedUpToSeq",
  DROP COLUMN IF EXISTS "historyCompactionSummary",
  DROP COLUMN IF EXISTS "historyCompactionGeneration";
