-- A shared bot keeps a bot memory for each person, and team memory stored under its owner.
-- The new key only adds "userId" to the old one, so no existing rows can collide under it.
DROP INDEX "memory_documents_spaceId_scope_botId_path_key";

CREATE UNIQUE INDEX "memory_documents_spaceId_scope_botId_userId_path_key" ON "memory_documents"("spaceId", "scope", "botId", "userId", "path");
