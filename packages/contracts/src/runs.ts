import * as z from "zod";
import { Id, RunStatus } from "./ids.js";

export const RunActivityRowSchema = z.object({
  runId: Id,
  botId: Id,
  botName: z.string(),
  groupId: Id.nullable(),
  groupName: z.string().nullable(),
  threadId: Id,
  status: RunStatus,
  trigger: z.enum([
    "user",
    "routine",
    "resume",
    "follow_up",
    "reaction",
    "spawn",
    "skill",
    "bot_message",
    "webhook",
    "messaging",
    "delegate",
    "delegate_followup",
    "work_return",
  ]),
  notificationsEnabled: z.boolean(),
  promptSnippet: z.string(),
  /** The delegated work this run carries, null for runs outside delegation. */
  workId: Id.nullable(),
  harness: z.string().nullable(),
  executionTarget: z.string().nullable(),
  choiceVersion: z.number().int().nullable(),
  updatedAt: z.string(),
});
export type RunActivityRow = z.infer<typeof RunActivityRowSchema>;

export const RunsListOutputSchema = z.object({
  runs: z.array(RunActivityRowSchema),
});
export type RunsListOutput = z.infer<typeof RunsListOutputSchema>;
