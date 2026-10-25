-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit transaction.
-- A provider VM belongs to exactly one attempt.
CREATE UNIQUE INDEX CONCURRENTLY "attempts_workerProviderKind_workerProviderRef_key"
ON "attempts"("workerProviderKind", "workerProviderRef") WHERE "workerProviderRef" IS NOT NULL;
