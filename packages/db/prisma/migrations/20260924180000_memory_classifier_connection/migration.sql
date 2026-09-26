CREATE TABLE "space_memory_classifier_configs" (
  "spaceId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "secretId" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "space_memory_classifier_configs_pkey" PRIMARY KEY ("spaceId")
);
CREATE UNIQUE INDEX "space_memory_classifier_configs_secretId_key" ON "space_memory_classifier_configs"("secretId");
ALTER TABLE "space_memory_classifier_configs" ADD CONSTRAINT "space_memory_classifier_configs_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "space_memory_classifier_configs" ADD CONSTRAINT "space_memory_classifier_configs_secretId_fkey"
  FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
