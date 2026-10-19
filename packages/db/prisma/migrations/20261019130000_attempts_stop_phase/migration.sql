-- How far the controller got stopping an attempt's guest. Additive and null on every existing
-- row, so the check is added NOT VALID and validated at once without rewriting the table.
ALTER TABLE "attempts" ADD COLUMN "stopPhase" TEXT;
ALTER TABLE "attempts" ADD COLUMN "stopPhaseAt" TIMESTAMP(3);

ALTER TABLE "attempts" ADD CONSTRAINT "attempts_stop_phase_check" CHECK (
    ("stopPhase" IS NULL AND "stopPhaseAt" IS NULL)
    OR ("stopPhase" IN ('requested', 'process_ended', 'unconfirmed') AND "stopPhaseAt" IS NOT NULL)
) NOT VALID;
ALTER TABLE "attempts" VALIDATE CONSTRAINT "attempts_stop_phase_check";
