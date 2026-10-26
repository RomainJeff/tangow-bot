import * as z from "zod";
import { Id, RunFailureKind, RunStatus, RunTrigger } from "./ids.js";

export const RunActivityRowSchema = z.object({
  runId: Id,
  botId: Id,
  botName: z.string(),
  groupId: Id.nullable(),
  groupName: z.string().nullable(),
  threadId: Id,
  status: RunStatus,
  trigger: RunTrigger,
  notificationsEnabled: z.boolean(),
  promptSnippet: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  routineId: Id.nullable(),
  routineName: z.string().nullable(),
  sourceMessageId: Id.nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  failureKind: RunFailureKind.nullable(),
});
export type RunActivityRow = z.infer<typeof RunActivityRowSchema>;

export const RunsListOutputSchema = z.object({
  runs: z.array(RunActivityRowSchema),
});
export type RunsListOutput = z.infer<typeof RunsListOutputSchema>;

export const RUNS_PAGE_DEFAULT = 30;
export const RUNS_PAGE_MAX = 50;

/**
 * Keyset position in a bot's activity, ordered by `(createdAt, id)` descending: a finished run is
 * still written to (mirrored, delivered), so `updatedAt` would move it across pages.
 */
export const RunsCursorSchema = z.object({ createdAt: z.iso.datetime(), id: Id });
export type RunsCursor = z.infer<typeof RunsCursorSchema>;

/**
 * One entry of a bot's activity, newest first: one of its runs (only its routines' unless asked
 * for all), a routine being created, or the bot itself being created. New kinds join the union.
 */
export const BotActivityItemSchema = z.discriminatedUnion("kind", [
  // Any run, from chat as well as from a routine: the name stays for the builds that read it.
  z.object({ kind: z.literal("routine_run"), run: RunActivityRowSchema }),
  z.object({
    kind: z.literal("routine_created"),
    routineId: Id,
    routineName: z.string(),
    createdAt: z.string(),
    /**
     * The bot that set it up from chat, on its own or from a proposal the person accepted. Null
     * when unknown: a routine made in the editor, or one whose thread is gone, look the same.
     */
    byBotName: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("bot_created"),
    botId: Id,
    botName: z.string(),
    createdAt: z.string(),
  }),
]);
export type BotActivityItem = z.infer<typeof BotActivityItemSchema>;

/** Active routine runs come first on the first page only and are never paged. */
export const BotActivityInputSchema = z.object({
  botId: Id,
  /** Only this routine's runs, for its own page. */
  routineId: Id.optional(),
  /** Every run of the bot, not only its routines' (debug mode); ignored with `routineId`. */
  allRuns: z.boolean().optional(),
  cursor: RunsCursorSchema.optional(),
  limit: z.number().int().min(1).max(RUNS_PAGE_MAX).optional(),
});
export type BotActivityInput = z.infer<typeof BotActivityInputSchema>;

export const BotActivityOutputSchema = z.object({
  items: z.array(BotActivityItemSchema),
  nextCursor: RunsCursorSchema.nullable(),
});
export type BotActivityOutput = z.infer<typeof BotActivityOutputSchema>;

/** What a run left in its thread, and the message to open it at. */
export const RunRecapSchema = z.object({
  text: z.string().nullable(),
  messageId: Id.nullable(),
});
export type RunRecap = z.infer<typeof RunRecapSchema>;
