-- AlterTable
ALTER TABLE "external_effects" ADD COLUMN     "answeredAt" TIMESTAMP(3);

-- Backfill: a refusal has not changed since it was answered.
UPDATE "external_effects" SET "answeredAt" = "updatedAt" WHERE "status" = 'denied';

-- CreateIndex
CREATE INDEX "external_effects_kind_status_runId_idx" ON "external_effects"("kind", "status", "runId");
