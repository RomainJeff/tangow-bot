import type { AdapterContext, FeedbackIssue, FeedbackProvider } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { z } from "zod";
import { sanitizeConnectorError } from "./connector-safety.js";
import { GITHUB_REPOSITORY_PATTERN, GithubFeedbackProvider } from "./github-feedback.js";

export const FeedbackKind = z.enum(["blocked", "malfunction", "excessive_steps", "other"]);
export const FeedbackImpact = z.enum(["blocked", "workaround", "completed_with_difficulty"]);

/** What the model reports: its own reading of the problem, never technical metadata. */
export const FeedbackInput = z.object({
  kind: FeedbackKind,
  summary: z.string().trim().min(1).max(500),
  expected: z.string().trim().min(1).max(1_000),
  impact: FeedbackImpact,
  tool: z.string().trim().max(120).optional(),
  reproduction: z.string().trim().max(2_000).optional(),
});
export type FeedbackInput = z.infer<typeof FeedbackInput>;

/** What Rakazo itself knows about the run when the model reports. */
export interface FeedbackContext {
  runId: string;
  threadId: string;
  botId: string;
  model: string | undefined;
  harness: string;
  version: string | undefined;
  reportedAt: Date;
  /** Read while the run is still going: never final totals. */
  measurements: FeedbackMeasurements;
}

export interface FeedbackMeasurements {
  elapsedSeconds: number | undefined;
  /** Usage rows, which include compaction calls: not a count of agent steps. */
  modelCalls: number;
  /** Audited tool completions, which can miss calls. */
  toolCalls: number;
  failedToolCalls: number;
}

const KIND_LABEL: Record<z.infer<typeof FeedbackKind>, string | undefined> = {
  blocked: "blocked",
  malfunction: "bug",
  excessive_steps: "friction",
  other: undefined,
};

const KIND_TEXT: Record<z.infer<typeof FeedbackKind>, string> = {
  blocked: "Blocked",
  malfunction: "Malfunction",
  excessive_steps: "Excessive steps",
  other: "Other",
};

const IMPACT_TEXT: Record<z.infer<typeof FeedbackImpact>, string> = {
  blocked: "Task blocked",
  workaround: "Worked around",
  completed_with_difficulty: "Completed with difficulty",
};

const TITLE_MAX_LENGTH = 120;

export function feedbackIssue(input: FeedbackInput, context: FeedbackContext): FeedbackIssue {
  const firstLine = (input.summary.split("\n", 1)[0] ?? "").replace(/\s+/g, " ").trim();
  const title =
    firstLine.length > TITLE_MAX_LENGTH
      ? `${firstLine.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`
      : firstLine;
  const { measurements } = context;
  const kindLabel = KIND_LABEL[input.kind];
  const reported = [
    `**Kind:** ${KIND_TEXT[input.kind]} · **Impact:** ${IMPACT_TEXT[input.impact]}${input.tool ? ` · **Tool:** \`${input.tool.replaceAll("`", "")}\`` : ""}`,
    "",
    "### Problem",
    input.summary,
    "",
    "### Expected",
    input.expected,
    ...(input.reproduction ? ["", "### Reproduction", input.reproduction] : []),
  ];
  const observed = [
    `- Run: \`${context.runId}\``,
    `- Thread: \`${context.threadId}\``,
    `- Bot: \`${context.botId}\``,
    `- Model: ${context.model ?? "unknown"}`,
    `- Harness: ${context.harness}`,
    ...(context.version ? [`- Rakazo version: ${context.version}`] : []),
    `- Reported at: ${context.reportedAt.toISOString()}`,
    "",
    "Counted while the run was still going, so these are not final totals:",
    "",
    ...(measurements.elapsedSeconds === undefined
      ? []
      : [`- Time since the run started: ${measurements.elapsedSeconds} s`]),
    `- Model calls recorded: ${measurements.modelCalls} (compaction calls included, so not a count of agent steps)`,
    `- Tool calls audited: ${measurements.toolCalls}, ${measurements.failedToolCalls} failed (the audit can miss calls)`,
  ];
  return {
    title,
    body: [
      "## Reported by the agent",
      "",
      ...reported,
      "",
      "## Observed by Rakazo",
      "",
      ...observed,
    ].join("\n"),
    labels: kindLabel ? ["agent-feedback", kindLabel] : ["agent-feedback"],
  };
}

/**
 * Runs the builtin `report_issue` tool. The executor's effect ledger already holds the call before
 * this runs and keeps what it returns, so a failed delivery stays recorded and never fails the run.
 */
export async function feedbackFromTool(
  deps: { prisma: PrismaClient; feedback: FeedbackProvider },
  report: Omit<FeedbackContext, "reportedAt" | "measurements"> & {
    args: Record<string, unknown>;
    secrets: string[];
  },
  context: AdapterContext,
) {
  const input = FeedbackInput.safeParse(report.args);
  if (!input.success) {
    return { error: `Invalid feedback: ${z.prettifyError(input.error)}` };
  }
  const measurements = await measureRun(deps.prisma, report.runId);
  const issue = feedbackIssue(input.data, { ...report, reportedAt: new Date(), measurements });
  const masked = {
    title: redactSecrets(issue.title, report.secrets),
    body: redactSecrets(issue.body, report.secrets),
    labels: issue.labels,
  };
  try {
    const { url } = await deps.feedback.deliver(masked, context);
    return { recorded: true, delivered: true, url, measurements };
  } catch (error) {
    context.signal.throwIfAborted();
    return {
      recorded: true,
      delivered: false,
      reason: sanitizeConnectorError(error, report.secrets),
      measurements,
    };
  }
}

async function measureRun(prisma: PrismaClient, runId: string): Promise<FeedbackMeasurements> {
  const audited = { runId, type: "agent.tool.completed" };
  const [run, modelCalls, toolCalls, failedToolCalls] = await Promise.all([
    prisma.run.findUnique({ where: { id: runId }, select: { startedAt: true } }),
    prisma.usageRecord.count({ where: { runId } }),
    prisma.event.count({ where: audited }),
    prisma.event.count({ where: { ...audited, payload: { path: ["outcome"], equals: "error" } } }),
  ]);
  return {
    elapsedSeconds: run?.startedAt
      ? Math.max(0, Math.round((Date.now() - run.startedAt.getTime()) / 1000))
      : undefined,
    modelCalls,
    toolCalls,
    failedToolCalls,
  };
}

/**
 * The operator's feedback destination from FEEDBACK_PROVIDER, or none. `secret` is the
 * credential the executor masks in everything a run writes.
 */
export function createFeedbackProvider(
  source: NodeJS.ProcessEnv = process.env,
): { provider: FeedbackProvider; secret: string } | undefined {
  const kind = source.FEEDBACK_PROVIDER?.trim().toLowerCase();
  if (!kind) return undefined;
  if (kind !== "github") throw new Error(`Unknown feedback provider "${kind}"`);
  const repository = source.FEEDBACK_GITHUB_REPOSITORY?.trim() ?? "";
  if (!GITHUB_REPOSITORY_PATTERN.test(repository)) {
    throw new Error("FEEDBACK_GITHUB_REPOSITORY must be owner/name");
  }
  const token = source.FEEDBACK_GITHUB_TOKEN?.trim();
  if (!token) throw new Error("Missing FEEDBACK_GITHUB_TOKEN");
  return { provider: new GithubFeedbackProvider({ repository, token }), secret: token };
}
