-- Canonical memory library. Existing rows keep their ids, content and revisions.
CREATE TABLE "memory_collections" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "ownerUserId" TEXT,
  "botId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "memory_collections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "memory_collections_spaceId_kind_ownerUserId_botId_key" ON "memory_collections"("spaceId", "kind", "ownerUserId", "botId") NULLS NOT DISTINCT;
CREATE INDEX "memory_collections_spaceId_kind_idx" ON "memory_collections"("spaceId", "kind");
ALTER TABLE "memory_collections" ADD CONSTRAINT "memory_collections_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_collections" ADD CONSTRAINT "memory_collections_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_collections" ADD CONSTRAINT "memory_collections_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "memory_commands" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "documentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "memory_commands_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "memory_commands_spaceId_userId_key_key" ON "memory_commands"("spaceId", "userId", "key");

ALTER TABLE "memory_documents" ADD COLUMN "collectionId" TEXT;
ALTER TABLE "memory_documents" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';
ALTER TABLE "memory_documents" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'proposed';
ALTER TABLE "memory_documents" ADD COLUMN "qualification" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "memory_documents" ADD COLUMN "validFrom" TIMESTAMP(3);
ALTER TABLE "memory_documents" ADD COLUMN "validUntil" TIMESTAMP(3);
ALTER TABLE "memory_documents" ADD COLUMN "sourceDocumentId" TEXT;
ALTER TABLE "memory_documents" ADD COLUMN "sourceRevision" INTEGER;
ALTER TABLE "memory_documents" ADD COLUMN "sourceKind" TEXT;
ALTER TABLE "memory_documents" ADD COLUMN "sourceReferenceId" TEXT;
ALTER TABLE "memory_documents" ADD COLUMN "sourceExcerpt" TEXT;
ALTER TABLE "memory_documents" ADD COLUMN "replacesDocumentId" TEXT;
ALTER TABLE "memory_documents" ADD COLUMN "accessVersion" INTEGER NOT NULL DEFAULT 1;

-- NULLs in a composite unique key are distinct in PostgreSQL; explicit partial keys keep backfill idempotent.
INSERT INTO "memory_collections" ("id", "spaceId", "kind", "ownerUserId", "botId")
SELECT 'legacy-personal-' || "spaceId" || '-' || "userId", "spaceId", 'personal', "userId", NULL
FROM "memory_documents" WHERE "scope" = 'user' OR "botId" IS NULL
ON CONFLICT DO NOTHING;
INSERT INTO "memory_collections" ("id", "spaceId", "kind", "ownerUserId", "botId")
SELECT 'legacy-agent-' || "spaceId" || '-' || "botId", "spaceId", 'agent', "userId", "botId"
FROM "memory_documents" WHERE "scope" = 'bot' AND "botId" IS NOT NULL
ON CONFLICT DO NOTHING;
UPDATE "memory_documents" d SET "collectionId" = CASE WHEN d."scope" = 'bot' AND d."botId" IS NOT NULL THEN 'legacy-agent-' || d."spaceId" || '-' || d."botId" ELSE 'legacy-personal-' || d."spaceId" || '-' || d."userId" END;
UPDATE "memory_documents" SET "title" = COALESCE(NULLIF(substring("content" from '#+\\s*([^\\n\\r]+)'), ''), "path"), "status" = 'proposed';
ALTER TABLE "memory_documents" ALTER COLUMN "collectionId" SET NOT NULL;
ALTER TABLE "memory_documents" ADD CONSTRAINT "memory_documents_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "memory_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "memory_documents_collectionId_status_updatedAt_idx" ON "memory_documents"("collectionId", "status", "updatedAt");

ALTER TABLE "memory_revisions" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';
ALTER TABLE "memory_revisions" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'proposed';
ALTER TABLE "memory_revisions" ADD COLUMN "qualification" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "memory_revisions" ADD COLUMN "validFrom" TIMESTAMP(3);
ALTER TABLE "memory_revisions" ADD COLUMN "validUntil" TIMESTAMP(3);
ALTER TABLE "memory_revisions" ADD COLUMN "accessVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "memory_revisions" ADD COLUMN "actorUserId" TEXT;
ALTER TABLE "memory_revisions" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "memory_revisions" ADD COLUMN "commandFingerprint" TEXT;
ALTER TABLE "memory_revisions" ADD COLUMN "sourceDocumentId" TEXT;
ALTER TABLE "memory_revisions" ADD COLUMN "sourceRevision" INTEGER;
ALTER TABLE "memory_revisions" ADD COLUMN "sourceKind" TEXT;
ALTER TABLE "memory_revisions" ADD COLUMN "sourceReferenceId" TEXT;
ALTER TABLE "memory_revisions" ADD COLUMN "sourceExcerpt" TEXT;
ALTER TABLE "memory_revisions" ADD COLUMN "replacesDocumentId" TEXT;
CREATE UNIQUE INDEX "memory_revisions_documentId_idempotencyKey_key" ON "memory_revisions"("documentId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
CREATE INDEX "memory_revisions_idempotencyKey_commandFingerprint_idx" ON "memory_revisions"("idempotencyKey", "commandFingerprint");

ALTER TABLE "runs" ADD COLUMN "memoryContextManifest" JSONB;
-- Runs from before governed memory had no memory dependencies; record that explicitly.
UPDATE "runs" SET "memoryContextManifest" = '[]'::jsonb;
