CREATE TABLE "bot_memory_methods" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "instructions" TEXT NOT NULL,
    "prepared" JSONB NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bot_memory_methods_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bot_memory_methods_botId_version_key" ON "bot_memory_methods"("botId", "version");

ALTER TABLE "bot_memory_methods" ADD CONSTRAINT "bot_memory_methods_botId_fkey"
FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_classification_runs"
ADD COLUMN "botId" TEXT,
ADD COLUMN "methodId" TEXT,
ADD COLUMN "methodVersion" INTEGER,
ADD COLUMN "methodSnapshot" JSONB;

ALTER TABLE "bots" ADD COLUMN "memoryMethodDisabledAt" TIMESTAMP(3);

ALTER TABLE "memory_classification_feedback"
ADD COLUMN "botId" TEXT,
ADD COLUMN "methodId" TEXT,
ADD COLUMN "methodVersion" INTEGER,
ADD COLUMN "reviewedQuestionKeys" JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX "memory_feedback_bot_method_scope_idx"
ON "memory_classification_feedback"("botId", "methodVersion", "collectionId", "revokedAt", "createdAt");

ALTER TABLE "memory_classification_runs" ADD CONSTRAINT "memory_classification_runs_botId_fkey"
FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "memory_classification_runs" ADD CONSTRAINT "memory_classification_runs_methodId_fkey"
FOREIGN KEY ("methodId") REFERENCES "bot_memory_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "memory_classification_feedback" ADD CONSTRAINT "memory_classification_feedback_methodId_fkey"
FOREIGN KEY ("methodId") REFERENCES "bot_memory_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;
