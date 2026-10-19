CREATE TABLE "memory_classification_runs" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "accessVersion" INTEGER NOT NULL,
    "sourceDigest" TEXT NOT NULL,
    "candidate" JSONB NOT NULL,
    "neighbors" JSONB NOT NULL,
    "prediction" JSONB NOT NULL,
    "examples" JSONB NOT NULL,
    "abstained" BOOLEAN NOT NULL DEFAULT false,
    "invalidResponse" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_classification_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memory_classification_feedback" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "sourceDigest" TEXT NOT NULL,
    "reviewed" JSONB NOT NULL,
    "prediction" JSONB NOT NULL,
    "payloadFingerprint" TEXT NOT NULL,
    "qualificationAfter" JSONB NOT NULL,
    "resultRevision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,

    CONSTRAINT "memory_classification_feedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_classification_feedback_runId_key" ON "memory_classification_feedback"("runId");
CREATE INDEX "memory_classification_runs_spaceId_userId_createdAt_idx" ON "memory_classification_runs"("spaceId", "userId", "createdAt");
CREATE INDEX "memory_classification_runs_documentId_createdAt_idx" ON "memory_classification_runs"("documentId", "createdAt");
CREATE INDEX "memory_classification_feedback_spaceId_userId_documentId_createdAt_idx" ON "memory_classification_feedback"("spaceId", "userId", "documentId", "createdAt");

ALTER TABLE "memory_classification_runs" ADD CONSTRAINT "memory_classification_runs_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "memory_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_classification_feedback" ADD CONSTRAINT "memory_classification_feedback_runId_fkey" FOREIGN KEY ("runId") REFERENCES "memory_classification_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_classification_feedback" ADD CONSTRAINT "memory_classification_feedback_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "memory_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
