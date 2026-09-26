-- CreateTable
CREATE TABLE "space_decision_configs" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "secretId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "space_decision_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "space_decision_configs_spaceId_key" ON "space_decision_configs"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "space_decision_configs_secretId_key" ON "space_decision_configs"("secretId");

-- AddForeignKey
ALTER TABLE "space_decision_configs" ADD CONSTRAINT "space_decision_configs_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_decision_configs" ADD CONSTRAINT "space_decision_configs_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
