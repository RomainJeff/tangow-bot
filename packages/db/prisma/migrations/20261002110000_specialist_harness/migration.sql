-- AlterTable
ALTER TABLE "scoped_tasks" ADD COLUMN     "harnessFallbackCause" TEXT,
ADD COLUMN     "harnessSource" TEXT,
ALTER COLUMN "harness" DROP NOT NULL,
ALTER COLUMN "executionTarget" DROP NOT NULL,
ALTER COLUMN "choiceVersion" DROP NOT NULL;

-- Same completeness rule as a Run's choice: Rakazo's own harness carries none of the three,
-- a native one carries all of them. Rows from before the choice was recorded satisfy it.
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
