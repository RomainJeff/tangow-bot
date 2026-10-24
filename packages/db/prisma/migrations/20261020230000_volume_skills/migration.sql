CREATE TABLE "volume_skills" (
  "id" TEXT PRIMARY KEY,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "source" TEXT NOT NULL CHECK ("source" IN ('managed', 'bot', 'shared')),
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("botId", "source", "name")
);
