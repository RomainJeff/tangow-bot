-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "exposedAt" TIMESTAMP(3),
ADD COLUMN     "exposureReason" TEXT;

-- AlterTable
ALTER TABLE "skill_settings" ADD COLUMN     "createdByBotId" TEXT;

-- AlterTable
ALTER TABLE "external_effects" ADD COLUMN     "answeredAt" TIMESTAMP(3);

-- Backfill: a refusal has not changed since it was answered.
UPDATE "external_effects" SET "answeredAt" = "updatedAt" WHERE "status" = 'denied';

-- Backfill: a skill a bot saved before provenance was kept is scoped to that bot alone.
UPDATE "skill_settings" s
SET "createdByBotId" = b."botId"
FROM "bot_skills" b
WHERE s."availability" = 'selected'
  AND s."createdByBotId" IS NULL
  AND s."skillKey" LIKE 'user:%'
  AND b."spaceId" = s."spaceId"
  AND b."userId" = s."userId"
  AND b."skillKey" = s."skillKey"
  AND b."enabled"
  AND (
    SELECT COUNT(*) FROM "bot_skills" o
    WHERE o."spaceId" = s."spaceId"
      AND o."userId" = s."userId"
      AND o."skillKey" = s."skillKey"
      AND o."enabled"
  ) = 1;
