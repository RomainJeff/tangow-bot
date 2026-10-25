-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit transaction (see prior
-- concurrent index migrations). The executor creates one attempt per claimed fence, so no
-- duplicates are expected. Pre-check on a copy of production before deploying:
--   SELECT "runId", "fence", count(*) FROM "attempts" GROUP BY 1, 2 HAVING count(*) > 1;
CREATE UNIQUE INDEX CONCURRENTLY "attempts_runId_fence_key" ON "attempts"("runId", "fence");
