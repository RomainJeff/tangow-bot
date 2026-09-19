-- Routine.notify was written but never read; it is now wired to gate the per-routine
-- notification toggle ("notify the user on each run of this routine"), which defaults to
-- silence. Flip the column default and reset existing rows so this change is behavior-neutral
-- for every routine created before the toggle existed.
ALTER TABLE "routines" ALTER COLUMN "notify" SET DEFAULT false;
UPDATE "routines" SET "notify" = false;
