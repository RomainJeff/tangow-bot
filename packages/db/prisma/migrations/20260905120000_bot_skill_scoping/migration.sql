-- Skills v2 phase 1: per-bot skill scoping. Existing skills keep today's behaviour
-- (visible to every bot) because a missing skill_settings row means "all".

CREATE TABLE "skill_settings" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "skillKey" TEXT NOT NULL,
  "availability" TEXT NOT NULL DEFAULT 'all',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "skill_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bot_skills" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "skillKey" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bot_skills_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "skill_settings_spaceId_userId_skillKey_key" ON "skill_settings"("spaceId", "userId", "skillKey");
CREATE UNIQUE INDEX "bot_skills_botId_skillKey_key" ON "bot_skills"("botId", "skillKey");
CREATE INDEX "bot_skills_spaceId_userId_skillKey_idx" ON "bot_skills"("spaceId", "userId", "skillKey");

ALTER TABLE "skill_settings" ADD CONSTRAINT "skill_settings_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_skills" ADD CONSTRAINT "bot_skills_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_skills" ADD CONSTRAINT "bot_skills_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
