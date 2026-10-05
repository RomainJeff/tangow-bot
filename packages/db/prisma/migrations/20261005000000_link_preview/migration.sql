-- AlterTable
ALTER TABLE "artifacts" ADD COLUMN     "isLinkPreview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "previewMessageId" TEXT;

-- CreateTable
CREATE TABLE "link_preview_reads" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_preview_reads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "link_preview_cache" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "format" TEXT,
    "title" TEXT,
    "imageKey" TEXT,
    "imageWidth" INTEGER,
    "imageHeight" INTEGER,
    "imageBytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "link_preview_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "link_preview_reads_spaceId_createdAt_idx" ON "link_preview_reads"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX "link_preview_reads_userId_createdAt_idx" ON "link_preview_reads"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "link_preview_cache_spaceId_createdAt_idx" ON "link_preview_cache"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX "link_preview_cache_expiresAt_idx" ON "link_preview_cache"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "link_preview_cache_spaceId_keyHash_key" ON "link_preview_cache"("spaceId", "keyHash");

-- CreateIndex
CREATE INDEX "artifacts_isLinkPreview_previewMessageId_idx" ON "artifacts"("isLinkPreview", "previewMessageId");

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_previewMessageId_fkey" FOREIGN KEY ("previewMessageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_preview_reads" ADD CONSTRAINT "link_preview_reads_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_preview_cache" ADD CONSTRAINT "link_preview_cache_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

