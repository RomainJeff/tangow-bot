-- Skills v2 phase 3: marketplaces live on the filesystem, DB row = lock (url/ref/commit/plugins).
CREATE TABLE "space_marketplaces" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "ref" TEXT NOT NULL DEFAULT 'HEAD',
  "commit" TEXT NOT NULL,
  "installedPlugins" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "space_marketplaces_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "space_marketplaces_spaceId_name_key" ON "space_marketplaces"("spaceId", "name");
ALTER TABLE "space_marketplaces" ADD CONSTRAINT "space_marketplaces_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Legacy skills table: exported to the filesystem at API boot since phase 2, no reader left.
DROP TABLE IF EXISTS "agent_skills";
