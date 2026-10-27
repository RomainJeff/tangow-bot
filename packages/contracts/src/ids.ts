import * as z from "zod";

export const Id = z.string().min(1);
export const IsoDate = z.string().datetime({ offset: true });

/** The id skills carried while they kept versions; skill lines written then still hold it. */
export const SkillUidSchema = z.string().regex(/^[0-9a-f]{32}$/);

export const ActorSchema = z.object({
  userId: Id,
  spaceId: Id,
  email: z.string().email(),
  isDeploymentOwner: z.boolean(),
});
export type Actor = z.infer<typeof ActorSchema>;

/** Number of organic avatar shape families a seed can select. */
export const AVATAR_SHAPE_COUNT = 12;

export const BOT_COLORS = [
  "#00C46A",
  "#3BC9A0",
  "#2E8CF0",
  "#8B5CF6",
  "#E45C9C",
  "#E0524A",
  "#F0913A",
] as const;

// Two hue-less bodies a bot can be given on purpose — ink (white eyes) and
// white (ink eyes, ink outline). Not part of the automatic rotation, which
// keeps handing new bots an identity hue; offered only as a deliberate choice.
export const SPECIAL_BOT_COLORS = ["#17181A", "#FFFFFF"] as const;

export const SELECTABLE_BOT_COLORS = [...BOT_COLORS, ...SPECIAL_BOT_COLORS] as const;

export const RunStatus = z.enum([
  "queued",
  "leased",
  "running",
  "waiting_input",
  "waiting_takeover",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunTrigger = z.enum([
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
  /** A helper inside its parent's attempt. */
  "subagent",
  /** A background helper on an attempt of its own, which outlives its parent's turn. */
  "helper",
]);
export type RunTrigger = z.infer<typeof RunTrigger>;

/** Why a run failed, as a code the client translates; the raw error text never leaves the server. */
export const RunFailureKind = z.enum(["missing_model", "computer", "provider", "other"]);
export type RunFailureKind = z.infer<typeof RunFailureKind>;

/** How a routine's most recent finished run ended; a completed run reads as succeeded. */
export const RoutineRunStatus = z.enum(["succeeded", "failed", "cancelled"]);
export type RoutineRunStatus = z.infer<typeof RoutineRunStatus>;

export const EffectStatus = z.enum(["intended", "completed", "failed", "ambiguous", "reconciled"]);
export type EffectStatus = z.infer<typeof EffectStatus>;

export const MemoryScope = z.enum(["bot", "user"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const ThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

export const SandboxKind = z.enum(["docker", "e2b", "fake"]);
export type SandboxKind = z.infer<typeof SandboxKind>;

/** The worker VM of one run attempt. Null on in-process attempts; live while requested, created or ready. */
export const WorkerState = z.enum(["requested", "created", "ready", "releasing", "released"]);
export type WorkerState = z.infer<typeof WorkerState>;

/** A bot's private volume, or the shared volume of its space. */
export const VolumeKind = z.enum(["bot_private", "space_shared"]);
export type VolumeKind = z.infer<typeof VolumeKind>;

export const VolumeAccess = z.enum(["rw", "ro"]);
export type VolumeAccess = z.infer<typeof VolumeAccess>;

/** Where a computer home lives durably: AgentHomeStore snapshots, or the bot and space volumes. */
export const HomeStorage = z.enum(["snapshot", "volumes"]);
export type HomeStorage = z.infer<typeof HomeStorage>;
