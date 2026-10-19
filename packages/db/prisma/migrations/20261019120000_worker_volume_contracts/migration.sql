-- Worker and volume contracts. Additive: nullable columns, one defaulted column, one new table,
-- and checks every existing row already satisfies. Indexes on attempts follow, built concurrently.

ALTER TABLE "attempts" ADD COLUMN "workerState" TEXT;
ALTER TABLE "attempts" ADD COLUMN "workerProviderKind" TEXT;
ALTER TABLE "attempts" ADD COLUMN "workerProviderRef" TEXT;
ALTER TABLE "attempts" ADD COLUMN "workerStateAt" TIMESTAMP(3);

-- A created or ready worker always has its provider ref, so a VM can never be lost.
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_worker_shape_check" CHECK (
    ("workerState" IS NULL AND "workerProviderKind" IS NULL AND "workerProviderRef" IS NULL
        AND "workerStateAt" IS NULL)
    OR (
        "workerState" IN ('requested', 'created', 'ready', 'releasing', 'released')
        AND "workerProviderKind" IS NOT NULL
        AND "workerStateAt" IS NOT NULL
        AND ("workerState" NOT IN ('created', 'ready') OR "workerProviderRef" IS NOT NULL)
    )
) NOT VALID;
ALTER TABLE "attempts" VALIDATE CONSTRAINT "attempts_worker_shape_check";

ALTER TABLE "computers" ADD COLUMN "homeStorage" TEXT NOT NULL DEFAULT 'snapshot';
ALTER TABLE "computers" ADD CONSTRAINT "computers_home_storage_check" CHECK (
    "homeStorage" = 'snapshot' OR ("homeStorage" = 'volumes' AND "kind" = 'e2b')
) NOT VALID;
ALTER TABLE "computers" VALIDATE CONSTRAINT "computers_home_storage_check";

CREATE TABLE "volumes" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT,
    "providerKind" TEXT NOT NULL,
    "providerRef" TEXT,
    "writerAttemptId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "volumes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "volumes_owner_shape_check" CHECK (
        ("kind" = 'bot_private' AND "botId" IS NOT NULL)
        OR ("kind" = 'space_shared' AND "botId" IS NULL)
    )
);

CREATE UNIQUE INDEX "volumes_botId_private_key" ON "volumes"("botId") WHERE "kind" = 'bot_private';
CREATE UNIQUE INDEX "volumes_spaceId_shared_key" ON "volumes"("spaceId") WHERE "kind" = 'space_shared';
CREATE UNIQUE INDEX "volumes_providerKind_providerRef_key" ON "volumes"("providerKind", "providerRef")
    WHERE "providerRef" IS NOT NULL;
CREATE INDEX "volumes_spaceId_idx" ON "volumes"("spaceId");
CREATE INDEX "volumes_writerAttemptId_idx" ON "volumes"("writerAttemptId");

ALTER TABLE "volumes" ADD CONSTRAINT "volumes_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "volumes" ADD CONSTRAINT "volumes_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "volumes" ADD CONSTRAINT "volumes_writerAttemptId_fkey"
    FOREIGN KEY ("writerAttemptId") REFERENCES "attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
