ALTER TABLE "space_members" ADD COLUMN "modelAuto" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "space_model_categories" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "thinkingLevel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "space_model_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "space_model_categories_credentialId_idx" ON "space_model_categories"("credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "space_model_categories_spaceId_userId_category_key" ON "space_model_categories"("spaceId", "userId", "category");

-- AddForeignKey
ALTER TABLE "space_model_categories" ADD CONSTRAINT "space_model_categories_spaceId_userId_fkey" FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_model_categories" ADD CONSTRAINT "space_model_categories_credentialId_userId_fkey" FOREIGN KEY ("credentialId", "userId") REFERENCES "user_model_credentials"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
