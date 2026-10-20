-- Additive: a provider volume whose row was deleted, written in the deleting transaction and
-- removed once the volume sweep deleted it at the provider.
CREATE TABLE "volume_deletions" (
    "providerKind" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "volumeId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "volume_deletions_pkey" PRIMARY KEY ("providerKind", "providerRef")
);
