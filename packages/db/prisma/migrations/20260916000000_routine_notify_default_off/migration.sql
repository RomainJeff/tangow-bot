-- `Routine.notify` was written but never read; it now gates the per-routine "notify me every
-- time" toggle, which ships with this change and defaults to silence. Flip the column default so
-- routines created from here on are quiet unless the user subscribes.
ALTER TABLE "routines" ALTER COLUMN "notify" SET DEFAULT false;

-- Every existing row is `true`, and none of them is a user choice: `true` was the column default
-- since the initial schema, both writers hardcoded it (the web routine form and the `schedule`
-- tool always sent `notify: true`), and no code read the column. There was no control to express
-- an opt-in with, so resetting cannot lose one.
--
-- Only sub-bot routines are reset — they are the only rows the new gate reads
-- (`notifiesUserOnRunEnd`), and leaving them `true` would page on every run and show a
-- "Subscribed" bell on routines nobody subscribed to. A top-level bot's own routine notifies
-- unconditionally regardless of this column, so its stored value is left untouched rather than
-- overwritten for no effect.
UPDATE "routines" SET "notify" = false
WHERE EXISTS (
    SELECT 1
    FROM "bots"
    WHERE "bots"."id" = "routines"."botId"
      AND "bots"."parentBotId" IS NOT NULL
);
