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
