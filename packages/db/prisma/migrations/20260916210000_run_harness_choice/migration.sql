-- T01-B: immutable, server-selected native execution snapshot for a Run.
ALTER TABLE "runs"
  ADD COLUMN "harness" TEXT,
  ADD COLUMN "executionTarget" TEXT,
  ADD COLUMN "choiceVersion" INTEGER;

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
