-- AlterTable
ALTER TABLE "link_preview_cache" ADD COLUMN     "crossSite" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "iconBytes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "iconKey" TEXT;
