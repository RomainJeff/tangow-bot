import { randomUUID } from "node:crypto";
import type { TSchema } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import type { AgentRunModel, AgentRunRequest, ConnectorTool } from "@rakazo/adapter-kit";
import { builtinAgentTools } from "./builtin-tools.js";
import type { LiveEvalGrade, LiveEvalTask, LiveEvalTaskId } from "./pi-live-eval-tasks.js";
import { LIVE_EVAL_INSTRUCTIONS } from "./pi-live-eval-tasks.js";
import {
  LiveEvalToolCounter,
  LiveEvalWorkspace,
  runWorkspaceTool,
} from "./pi-live-eval-workspace.js";
import { PiAgentRuntime, parametersFor } from "./pi-runtime.js";
import { MODEL_STREAM_MAX_RETRIES, MODEL_STREAM_TIMEOUT_MS } from "./pi-runtime-limits.js";
import { createProofSession } from "./pi-sdk-proof-support.js";
import type { RunTrace } from "./run-trace.js";
import { TraceExporter } from "./trace-export.js";

export const LIVE_EVAL_ARMS = ["current-runtime", "sdk-same-tools", "sdk-native-files"] as const;
export type LiveEvalArm = (typeof LIVE_EVAL_ARMS)[number];

export const LIVE_EVAL_DEADLINE_MS = 180_000;
export const LIVE_EVAL_SETTLE_MS = 5_000;

/** The ModelRuntime and resolved model the SDK arms run on, as createProofSession takes them. */
export type LiveEvalSdkModel = Parameters<typeof createProofSession>[0]["runtime"];

export interface LiveEvalArmInput {
  arm: LiveEvalArm;
  task: LiveEvalTask;
  /** Absolute scratch directory: the SDK session cwd and the virtual workspace root. */
  cwd: string;
  agentDir: string;
  models: { runtime: AgentRunModel; sdk: LiveEvalSdkModel };
  signal: AbortSignal;
  /** Values the current runtime redacts from its in-process trace. */
  secrets?: readonly string[];
  deadlineMs?: number;
  maxToolCalls?: number;
}

export type LiveEvalStatus = "completed" | "failed" | "aborted" | "deadline" | "tool_budget";
export type LiveEvalErrorCode = "run_error" | "unsettled";

export interface LiveEvalUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface LiveEvalMetrics {
  /** From before engine construction until the run settled. */
  wallMs: number;
  /** First streamed text or thinking delta, or first tool execution, whichever came first. */
  firstTokenMs: number | null;
  modelTurns: number;
  toolCalls: number;
  toolErrors: number;
  usage: LiveEvalUsage;
  /** Catalog-price estimate for a completed run; null when the run did not complete. */
  costUSD: number | null;
}

export interface LiveEvalArmResult {
  arm: LiveEvalArm;
  task: LiveEvalTaskId;
  seed: number;
  status: LiveEvalStatus;
  /** The engine finished without throwing, failing or being aborted. */
  done: boolean;
  errors: LiveEvalErrorCode[];
  /** Milliseconds from abort until the engine settled; null without an abort. */
  settleMs: number | null;
  metrics: LiveEvalMetrics;
  grade: LiveEvalGrade;
  /** Final workspace files, for grading and inspection. Model-written; keep out of reports. */
  artifacts: ReadonlyMap<string, string>;
}

const FILE_TOOL_NAMES = ["list_files", "read_file", "write_file", "edit_file"];
export const LIVE_EVAL_RUN_CHECK_TOOL: ConnectorTool = {
  name: "run_check",
  description:
    "Check the project files against the task's rules. Returns the failures found, or that all checks passed.",
  inputSchema: { type: "object", properties: {} },
  readOnly: true,
};
export const LIVE_EVAL_SHARED_TOOLS: readonly ConnectorTool[] = [
  ...FILE_TOOL_NAMES.map((name) => {
    const tool = builtinAgentTools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Builtin tool ${name} is missing`);
    return tool;
  }),
  LIVE_EVAL_RUN_CHECK_TOOL,
];

interface Probe {
  startedAt: number;
  firstTokenAt: number | null;
  modelTurns: number;
  usage: LiveEvalUsage;
  cost: number | null;
}

interface EngineOutcome {
  done: boolean;
  error: boolean;
  settled: boolean;
  settleMs: number | null;
}

interface ArmContext {
  input: LiveEvalArmInput;
  signal: AbortSignal;
  probe: Probe;
  runTool(name: string, args: Record<string, unknown>): Promise<string>;
  counted<P extends TSchema, D, S>(tool: ToolDefinition<P, D, S>): ToolDefinition;
  workspace: LiveEvalWorkspace;
}

const markFirstToken = (probe: Probe) => {
  probe.firstTokenAt ??= Date.now();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function runLiveEvalArm(input: LiveEvalArmInput): Promise<LiveEvalArmResult> {
  const probe: Probe = {
    startedAt: Date.now(),
    firstTokenAt: null,
    modelTurns: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: null,
  };
  const budget = new AbortController();
  const deadline = AbortSignal.timeout(input.deadlineMs ?? LIVE_EVAL_DEADLINE_MS);
  const signal = AbortSignal.any([input.signal, deadline, budget.signal]);
  const counter = new LiveEvalToolCounter(() => budget.abort(), input.maxToolCalls);
  const workspace = new LiveEvalWorkspace({ root: input.cwd, files: input.task.files, signal });
  const runTool = (name: string, args: Record<string, unknown>) =>
    counter.run(async () => {
      if (name !== LIVE_EVAL_RUN_CHECK_TOOL.name) return runWorkspaceTool(workspace, name, args);
      const failures = input.task.check(workspace.snapshot());
      return failures.length
        ? `${failures.length} check failures:\n${failures.join("\n")}`
        : "All checks passed.";
    });
  const counted = <P extends TSchema, D, S>(tool: ToolDefinition<P, D, S>): ToolDefinition =>
    defineTool({ ...tool, execute: (...args) => counter.run(() => tool.execute(...args)) });
  const context: ArmContext = { input, signal, probe, runTool, counted, workspace };
  const outcome =
    input.arm === "current-runtime" ? await runCurrentRuntime(context) : await runSdk(context);
  const artifacts = workspace.snapshot();
  const status: LiveEvalStatus = budget.signal.aborted
    ? "tool_budget"
    : deadline.aborted
      ? "deadline"
      : input.signal.aborted
        ? "aborted"
        : outcome.error
          ? "failed"
          : "completed";
  return {
    arm: input.arm,
    task: input.task.id,
    seed: input.task.seed,
    status,
    done: outcome.done,
    errors: [
      ...(outcome.error ? (["run_error"] as const) : []),
      ...(outcome.settled ? [] : (["unsettled"] as const)),
    ],
    settleMs: outcome.settleMs,
    metrics: {
      wallMs: Date.now() - probe.startedAt,
      firstTokenMs: probe.firstTokenAt === null ? null : probe.firstTokenAt - probe.startedAt,
      modelTurns: probe.modelTurns,
      toolCalls: counter.calls,
      toolErrors: counter.errors,
      usage: probe.usage,
      costUSD: status === "completed" ? probe.cost : null,
    },
    grade: input.task.grade(artifacts),
    artifacts,
  };
}

/** Waits for work; after an abort, calls stop and waits at most LIVE_EVAL_SETTLE_MS for both. */
async function settle(
  work: Promise<unknown>,
  signal: AbortSignal,
  stop: () => Promise<void>,
): Promise<Omit<EngineOutcome, "done">> {
  let error = false;
  const finished = work.then(
    () => undefined,
    () => {
      error = true;
    },
  );
  let abortedAt: number | undefined;
  let stopping: Promise<void> = Promise.resolve();
  let wake = () => {};
  const aborted = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const onAbort = () => {
    abortedAt = Date.now();
    stopping = stop().catch(() => undefined);
    wake();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([finished, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (abortedAt === undefined) return { error, settled: true, settleMs: null };
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    Promise.all([finished, stopping]).then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), LIVE_EVAL_SETTLE_MS);
    }),
  ]);
  clearTimeout(timer);
  return { error, settled, settleMs: settled ? Date.now() - abortedAt : null };
}

/** Keeps the run trace in memory; nothing is sent anywhere. */
class LiveEvalTraceCollector extends TraceExporter {
  readonly traces: RunTrace[] = [];

  constructor() {
    super({ send: () => Promise.reject(new Error("Live eval traces stay in process")) });
  }

  override export(trace: RunTrace): void {
    this.traces.push(trace);
  }
}

const numberAt = (value: unknown, key: string) =>
  isRecord(value) && typeof value[key] === "number" ? value[key] : 0;

function parseAttribute(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readTrace(trace: RunTrace, probe: Probe) {
  const spans = trace.getSpans();
  const root = spans.find((span) => span.parentId === null);
  for (const span of spans) {
    if (span.parentId !== root?.id) continue;
    if (span.attributes["langfuse.observation.type"] !== "generation") continue;
    probe.modelTurns += 1;
    const usage = parseAttribute(span.attributes["langfuse.observation.usage_details"]);
    probe.usage.input += numberAt(usage, "input");
    probe.usage.output += numberAt(usage, "output");
    probe.usage.cacheRead += numberAt(usage, "cache_read");
    probe.usage.cacheWrite += numberAt(usage, "cache_write");
    const cost = parseAttribute(span.attributes["langfuse.observation.cost_details"]);
    if (isRecord(cost) && typeof cost.total === "number")
      probe.cost = (probe.cost ?? 0) + cost.total;
    const started = span.attributes["langfuse.observation.completion_start_time"];
    const at = typeof started === "string" ? Date.parse(started) : Number.NaN;
    if (Number.isFinite(at) && (probe.firstTokenAt === null || at < probe.firstTokenAt)) {
      probe.firstTokenAt = at;
    }
  }
}

async function runCurrentRuntime(context: ArmContext): Promise<EngineOutcome> {
  const { input, probe } = context;
  const collector = new LiveEvalTraceCollector();
  const runtime = new PiAgentRuntime({ traceExporter: collector });
  const runId = `live-eval-${randomUUID()}`;
  const request: AgentRunRequest = {
    botId: "live-eval",
    threadId: runId,
    runId,
    prompt: input.task.prompt,
    instructions: LIVE_EVAL_INSTRUCTIONS,
    history: [],
    tools: [...LIVE_EVAL_SHARED_TOOLS],
    model: input.models.runtime,
    secrets: input.secrets ?? [],
    executeTool: async (name, args) => ({
      kind: "agent_tool_result",
      content: [{ type: "text", text: await context.runTool(name, args) }],
      details: {},
    }),
  };
  let done = false;
  const work = (async () => {
    for await (const event of runtime.run(request, { signal: context.signal })) {
      if (event.type === "text" || event.type === "tool") markFirstToken(probe);
      if (event.type === "done") done = true;
    }
  })();
  const outcome = await settle(work, context.signal, () => runtime.abort(runId));
  for (const trace of collector.traces) readTrace(trace, probe);
  return { ...outcome, done };
}

function sameTool(context: ArmContext, tool: ConnectorTool): ToolDefinition {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: parametersFor(tool),
    execute: async (_toolCallId, params) => ({
      content: [
        { type: "text", text: await context.runTool(tool.name, isRecord(params) ? params : {}) },
      ],
      details: {},
    }),
  };
}

function sdkTools(context: ArmContext): ToolDefinition[] {
  if (context.input.arm === "sdk-same-tools") {
    return LIVE_EVAL_SHARED_TOOLS.map((tool) => sameTool(context, tool));
  }
  const operations = context.workspace.nativeOperations();
  const { cwd } = context.input;
  return [
    ...LIVE_EVAL_SHARED_TOOLS.filter(
      (tool) => tool.name === "list_files" || tool.name === LIVE_EVAL_RUN_CHECK_TOOL.name,
    ).map((tool) => sameTool(context, tool)),
    context.counted(
      createReadToolDefinition(cwd, { operations: operations.read, autoResizeImages: false }),
    ),
    context.counted(createWriteToolDefinition(cwd, { operations: operations.write })),
    context.counted(createEditToolDefinition(cwd, { operations: operations.edit })),
  ];
}

async function runSdk(context: ArmContext): Promise<EngineOutcome> {
  const { input, probe, signal } = context;
  const session = await createProofSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    runtime: input.models.sdk,
    systemPrompt: LIVE_EVAL_INSTRUCTIONS,
    tools: sdkTools(context),
  });
  session.setThinkingLevel(input.models.runtime.thinkingLevel ?? "medium");
  session.settingsManager.applyOverrides({
    retry: {
      enabled: false,
      provider: { timeoutMs: MODEL_STREAM_TIMEOUT_MS, maxRetries: MODEL_STREAM_MAX_RETRIES },
    },
  });
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") markFirstToken(probe);
    if (
      event.type === "message_update" &&
      (event.assistantMessageEvent.type === "text_delta" ||
        event.assistantMessageEvent.type === "thinking_delta")
    ) {
      markFirstToken(probe);
    }
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    probe.modelTurns += 1;
    const { usage } = event.message;
    probe.usage.input += usage.input;
    probe.usage.output += usage.output;
    probe.usage.cacheRead += usage.cacheRead;
    probe.usage.cacheWrite += usage.cacheWrite;
    probe.cost = (probe.cost ?? 0) + usage.cost.total;
  });
  try {
    if (signal.aborted) return { done: false, error: false, settled: true, settleMs: 0 };
    const work = (async () => {
      await session.prompt(input.task.prompt, { expandPromptTemplates: false });
      await session.agent.waitForIdle();
    })();
    const outcome = await settle(work, signal, () => session.abort());
    const failed = Boolean(session.agent.state.errorMessage) && !signal.aborted;
    return {
      ...outcome,
      error: outcome.error || failed,
      done: !outcome.error && !signal.aborted && !failed,
    };
  } finally {
    unsubscribe();
    session.dispose();
  }
}
