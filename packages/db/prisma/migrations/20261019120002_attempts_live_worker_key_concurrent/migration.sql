-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit transaction.
-- At most one live worker per run: a newer attempt moves the older worker to 'releasing' first.
CREATE UNIQUE INDEX CONCURRENTLY "attempts_runId_live_worker_key" ON "attempts"("runId")
WHERE "workerState" IN ('requested', 'created', 'ready');
