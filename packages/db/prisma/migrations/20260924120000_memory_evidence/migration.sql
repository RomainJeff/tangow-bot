-- Keep exact source evidence separate from proposal content and qualify it by revision.
CREATE TABLE "memory_evidence" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "sourceKind" TEXT NOT NULL,
  "sourceRole" TEXT,
  "sourceReferenceId" TEXT NOT NULL,
  "sourceVersion" TEXT NOT NULL,
  "sourceDigest" TEXT NOT NULL,
  "startOffset" INTEGER,
  "endOffset" INTEGER,
  "excerpt" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "memory_evidence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "memory_evidence_documentId_revision_sourceKind_sourceReferenceId_sourceVersion_key"
  ON "memory_evidence"("documentId", "revision", "sourceKind", "sourceReferenceId", "sourceVersion");
CREATE INDEX "memory_evidence_sourceKind_sourceReferenceId_idx"
  ON "memory_evidence"("sourceKind", "sourceReferenceId");
ALTER TABLE "memory_evidence" ADD CONSTRAINT "memory_evidence_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "memory_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_evidence" ADD CONSTRAINT "memory_evidence_documentId_revision_fkey"
  FOREIGN KEY ("documentId", "revision") REFERENCES "memory_revisions"("documentId", "revision") ON DELETE CASCADE ON UPDATE CASCADE;

-- Durable work intent so advancing a compaction cursor cannot silently lose candidates.
CREATE TABLE "memory_capture_requests" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "historyGeneration" INTEGER NOT NULL,
  "fromSeqExclusive" INTEGER NOT NULL,
  "toSeqInclusive" INTEGER NOT NULL,
  "sourceMessages" JSONB NOT NULL,
  "memoryManifest" JSONB NOT NULL,
  "candidates" JSONB,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "memory_capture_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "memory_capture_requests_idempotencyKey_key"
  ON "memory_capture_requests"("idempotencyKey");
CREATE INDEX "memory_capture_requests_threadId_status_createdAt_idx"
  ON "memory_capture_requests"("threadId", "status", "createdAt");
ALTER TABLE "memory_capture_requests" ADD CONSTRAINT "memory_capture_requests_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
