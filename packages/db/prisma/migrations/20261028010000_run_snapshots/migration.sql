ALTER TABLE runs ADD COLUMN "resumeRequired" BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE run_snapshots (
  "runId" TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  "sessionId" TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  receipts JSONB NOT NULL DEFAULT '[]'
);

CREATE FUNCTION delete_terminal_run_snapshot() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM run_snapshots WHERE "runId" = NEW.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER runs_delete_terminal_snapshot
AFTER UPDATE OF status ON runs
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('completed', 'failed', 'cancelled'))
EXECUTE FUNCTION delete_terminal_run_snapshot();
