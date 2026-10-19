-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit transaction.
-- Reconciliation scans unreleased workers, oldest first; empty on every historical attempt.
CREATE INDEX CONCURRENTLY "attempts_worker_reconcile_idx" ON "attempts"("workerStateAt", "id")
WHERE "workerState" IN ('requested', 'created', 'ready', 'releasing');
