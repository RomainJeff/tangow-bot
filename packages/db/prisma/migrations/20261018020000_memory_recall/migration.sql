ALTER TABLE "runs" ADD COLUMN "memoryContextManifest" JSONB;
-- Runs from before governed memory had no memory dependencies; record that explicitly.
UPDATE "runs" SET "memoryContextManifest" = '[]'::jsonb;

ALTER TABLE "spaces" ADD COLUMN "memoryRecallEnabled" BOOLEAN NOT NULL DEFAULT true;
