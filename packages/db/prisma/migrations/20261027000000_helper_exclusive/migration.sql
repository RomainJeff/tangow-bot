-- A helper run names its profile and the resource it holds. One active run of a bot holds each
-- resource; the statuses are ACTIVE_RUN_STATUSES in @rakazo/core.
ALTER TABLE "runs" ADD COLUMN "helper" TEXT;
ALTER TABLE "runs" ADD COLUMN "exclusive" TEXT;
CREATE UNIQUE INDEX "runs_botId_exclusive_active_key" ON "runs"("botId", "exclusive")
WHERE "status" IN ('queued', 'leased', 'running', 'waiting_input', 'waiting_takeover');
