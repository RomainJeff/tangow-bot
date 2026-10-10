-- A routine a bot set up on someone else's word must not let its runs save skills. Routines made
-- mid bot-to-bot chain are the ones known to come from such a run.
ALTER TABLE "routines" ADD COLUMN "untrustedPrompt" BOOLEAN NOT NULL DEFAULT false;
UPDATE "routines" SET "untrustedPrompt" = true WHERE "inheritedHop" IS NOT NULL;
