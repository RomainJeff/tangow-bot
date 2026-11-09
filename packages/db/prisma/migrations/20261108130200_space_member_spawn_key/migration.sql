-- Each person's first bot of a Space is spawned under the same onboarding key.
DROP INDEX "bots_spaceId_spawnKey_key";
CREATE UNIQUE INDEX "bots_spaceId_userId_spawnKey_key" ON "bots"("spaceId", "userId", "spawnKey");
