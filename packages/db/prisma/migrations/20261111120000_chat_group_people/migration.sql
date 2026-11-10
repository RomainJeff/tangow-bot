-- The people in a group, each with their own read, pin and section state. Bots stay in
-- chat_group_members; chat_groups."userId" stays the creator.
CREATE TABLE "chat_group_people" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "unread" BOOLEAN NOT NULL DEFAULT false,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "sectionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_group_people_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_group_people_userId_idx" ON "chat_group_people"("userId");

-- CreateIndex
CREATE INDEX "chat_group_people_sectionId_idx" ON "chat_group_people"("sectionId");

-- CreateIndex
CREATE UNIQUE INDEX "chat_group_people_groupId_userId_key" ON "chat_group_people"("groupId", "userId");

-- AddForeignKey
ALTER TABLE "chat_group_people" ADD CONSTRAINT "chat_group_people_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "chat_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_group_people" ADD CONSTRAINT "chat_group_people_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_group_people" ADD CONSTRAINT "chat_group_people_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "bot_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Every existing group gets its creator, who keeps the group's pin, section and the thread's
-- unread mark: that state is theirs from now on, and the group's own copies go.
INSERT INTO "chat_group_people" ("id", "groupId", "userId", "unread", "pinned", "sectionId", "createdAt")
SELECT gen_random_uuid()::text, g."id", g."userId", COALESCE(t."unread", false), g."pinned",
  g."sectionId", g."createdAt"
FROM "chat_groups" g
INNER JOIN "user" u ON u."id" = g."userId"
LEFT JOIN "threads" t ON t."groupId" = g."id";

UPDATE "threads" SET "unread" = false WHERE "groupId" IS NOT NULL;

-- DropForeignKey
ALTER TABLE "chat_groups" DROP CONSTRAINT IF EXISTS "chat_groups_sectionId_fkey";

-- DropIndex
DROP INDEX IF EXISTS "chat_groups_spaceId_userId_archivedAt_pinned_updatedAt_idx";

-- DropIndex
DROP INDEX IF EXISTS "chat_groups_sectionId_idx";

-- The bot that answers a message naming no bot; null is the first bot.
ALTER TABLE "chat_groups" DROP COLUMN "pinned",
DROP COLUMN "sectionId",
ADD COLUMN     "leadBotId" TEXT;

-- CreateIndex
CREATE INDEX "chat_groups_spaceId_userId_archivedAt_updatedAt_idx" ON "chat_groups"("spaceId", "userId", "archivedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "chat_groups_leadBotId_idx" ON "chat_groups"("leadBotId");

-- AddForeignKey
ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_leadBotId_fkey" FOREIGN KEY ("leadBotId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
