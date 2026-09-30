-- T02:2: record the MCP callId a lifecycle event reserves, so a retransmitted
-- callId under the same binding is one operation, not a replayed side effect.
-- Additive only: new nullable column, new index; no backfill (table is new/empty
-- as of the previous migration, and existing rows never carried a callId).
ALTER TABLE "lifecycle_events" ADD COLUMN "callId" TEXT;

CREATE INDEX "lifecycle_events_botId_threadId_callId_idx" ON "lifecycle_events"("botId", "threadId", "callId");

-- Partial unique index: only rows that record a callId are constrained, so the
-- reservation insert in native-session-host.ts can rely on ON CONFLICT to make
-- "same callId retransmitted under the same binding" a single operation.
CREATE UNIQUE INDEX "lifecycle_events_botId_threadId_callId_unique"
  ON "lifecycle_events"("botId", "threadId", "callId")
  WHERE "callId" IS NOT NULL;
