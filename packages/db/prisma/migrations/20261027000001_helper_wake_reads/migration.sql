-- How far a conversation turn read its main session, so a helper report wakes the bot only when
-- no turn read it; and a helper's name and instructions, kept whole for its own attempt.
ALTER TABLE "runs" ADD COLUMN "historyThroughSeq" INTEGER;
ALTER TABLE "tasks" ADD COLUMN "helperName" TEXT;
ALTER TABLE "tasks" ADD COLUMN "helperInstructions" TEXT;
