ALTER TABLE "spaces" ADD COLUMN "skillIndexAttemptStartedAt" TIMESTAMP(3), ADD COLUMN "skillIndexAttemptId" TEXT;
-- Shared contents may contain credentials belonging to another bot. Never retain them.
UPDATE "volume_skills" SET "content" = '' WHERE "source" = 'shared';
DELETE FROM "volume_skills" WHERE "source" = 'managed';
