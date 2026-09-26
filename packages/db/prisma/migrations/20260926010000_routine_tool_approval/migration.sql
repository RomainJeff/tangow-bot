-- Inbound routine wakes used to force approval on every action. Keep that as the default for
-- existing and new routines, and let the owner opt a routine out; the run records the outcome.
ALTER TABLE "routines" ADD COLUMN "requireToolApproval" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "runs" ADD COLUMN "requireToolApproval" BOOLEAN NOT NULL DEFAULT true;
