-- Who besides the owner uses a bot: nobody, every member of its Space, or the people in bot_shares.
ALTER TABLE "bots" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'private';
ALTER TABLE "bots" ADD CONSTRAINT "bots_visibility_chk"
  CHECK ("visibility" IN ('private', 'space', 'people'));

-- CreateTable
CREATE TABLE "bot_shares" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bot_shares_userId_idx" ON "bot_shares"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "bot_shares_botId_userId_key" ON "bot_shares"("botId", "userId");

-- AddForeignKey
ALTER TABLE "bot_shares" ADD CONSTRAINT "bot_shares_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_shares" ADD CONSTRAINT "bot_shares_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A member's own thread with a shared bot. "botId" stays the owner's thread.
ALTER TABLE "threads" ADD COLUMN "memberBotId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "threads_memberBotId_userId_key" ON "threads"("memberBotId", "userId");

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_memberBotId_fkey" FOREIGN KEY ("memberBotId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "threads" DROP CONSTRAINT "threads_owner_chk";
ALTER TABLE "threads" ADD CONSTRAINT "threads_owner_chk" CHECK (
  num_nonnulls("botId", "groupId", "externalConversationId", "memberBotId") = 1
);
