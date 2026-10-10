-- A routine a bot set up on someone else's word must not let its runs save skills: one made mid
-- bot-to-bot chain, or one a run the user did not start created or rewrote (schedule_create, a
-- change when it names a routineId). A follow_up is the user's only when its source message is.
ALTER TABLE "routines" ADD COLUMN "untrustedPrompt" BOOLEAN NOT NULL DEFAULT false;
UPDATE "routines" SET "untrustedPrompt" = true
WHERE "inheritedHop" IS NOT NULL
   OR EXISTS (
     SELECT 1
     FROM "external_effects" e
     JOIN "runs" r ON r."id" = e."runId"
     LEFT JOIN "messages" m ON m."id" = r."sourceMessageId"
     WHERE e."kind" = 'schedule_create'
       AND e."result"->>'routineId' = "routines"."id"
       AND r."trigger" NOT IN ('user', 'reaction', 'skill')
       AND NOT (r."trigger" = 'follow_up' AND COALESCE(m."role", '') = 'user')
   );

-- A message someone other than the user sent into a busy run.
ALTER TABLE "steering_messages" ADD COLUMN "untrusted" BOOLEAN NOT NULL DEFAULT false;
