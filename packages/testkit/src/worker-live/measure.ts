import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ConnectorProvider, SandboxProvider, WorkerProvider } from "@tangow/adapter-kit";
import type { GuestConnector } from "@tangow/adapters/runtime-worker";
import { HARNESSES } from "@tangow/agent-run-worker";
import type { LogEvent } from "@tangow/logging";
import { createLogger, getLogger, installLogger } from "@tangow/logging";
import { latestCard } from "../index.js";
import { LocalWorkerProvider } from "../local-worker-provider.js";
import type { ModelEmulatorStep } from "../model-emulator.js";
import type { Seen } from "../worker-channel-tap.js";
import { parse, queryLog, settled, tapConnector } from "../worker-channel-tap.js";
import { startWorkerRun } from "../worker-run-fixture.js";
import { forward } from "./session.js";

export type ScenarioId = "chain" | "computer" | "approval" | "compaction";
export const SCENARIOS: ScenarioId[] = ["chain", "computer", "approval", "compaction"];

export type MeasureProtocol = {
  scenarios: ScenarioId[];
  trials: number;
  /** Idle times between chained exchanges, around the provider's cache lifetime. */
  gapsMs: number[];
  /** How long an approval waits before it is granted. */
  approvalDelaysMs: number[];
};

/** One user message of a scenario's thread. */
type Turn = {
  /** Idle time after the previous run settled. */
  waitMs: number;
  prompt: string;
  approveAfterMs?: number;
  /** The product's history compaction runs first, as its job would. */
  compact?: boolean;
};

/** One model request, as the relay measured it in `agent.worker.model_request`. */
export type RequestRecord = {
  attemptId: string;
  agent: string;
  usageReported: boolean;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  promptBytes?: number;
  commonPrefixBytes?: number;
  previousRequest?: boolean;
  firstDivergingSection?: string | null;
  /** Between the ends of this and the previous request to the same model, in any thread. */
  sinceSameModelMs: number | null;
};

export type TurnRecord = {
  waitMs: number;
  approveAfterMs?: number;
  compacted: boolean;
  compactionMs?: number;
  status: string;
  error?: string;
  approvalRequested: boolean;
  /**
   * From the grant's persistence to the resumed attempt's first relayed model request, minus the
   * worker's provisioning (provider ensure to guest hello), which is `provisioningMs`.
   */
  restoreOutsideProvisioningMs?: number | null;
  provisioningMs?: number;
  /** Each native transcript delta's append at the controller. */
  appends: Array<{ ms: number; queries: number }>;
  requests: RequestRecord[];
};

export type ThreadRecord = {
  scenario: ScenarioId;
  model: string;
  trial: number;
  turns: TurnRecord[];
  /** In the tool catalog, so threads never share a prompt prefix past the harness's own. */
  nonce: string;
  /** Why the thread stopped before its last turn. */
  error?: string;
  rateLimitRetries?: number;
  /**
   * The thread's first provider request body against those of the model's earlier threads: the
   * longest prefix it shares with one of them, its length, and where its tools and its nonce start,
   * in characters.
   */
  sharedBase?: { sharedChars: number; bodyChars: number; nonceAt: number; toolsAt?: number };
  /** Whether that first body carried provider cache markers (`cache_control`). */
  cacheMarkersSent?: boolean;
  left?: { sandboxes: number; volumes: number };
};

/**
 * Guests on this machine whose working directory stays the same across a thread's attempts, as
 * a worker VM's does; the per-attempt directory of the local provider would change Pi's prompt.
 */
export function stableLocalWorkers(root: string) {
  const local = new LocalWorkerProvider({ mode: "memory", root, harness: HARNESSES["pi-native"] });
  // One directory serves every attempt in turn; each attempt still gets its own reference.
  const vm = { attemptId: "vm", providerRef: "local-vm" };
  return {
    local,
    provider: forward(local, {
      async ensure(spec, ctx) {
        await local.ensure({ ...spec, attemptId: vm.attemptId }, ctx);
        return { providerRef: `${vm.providerRef}-${spec.attemptId}` };
      },
      connect: (target, capability) =>
        local.connect({ attemptId: target.attemptId, providerRef: vm.providerRef }, capability),
      destroy: (target, ctx) => local.destroy({ ...target, attemptId: vm.attemptId }, ctx),
    }),
  };
}

export type MeasuredModel = {
  provider: string;
  id: string;
  api: Api;
  baseUrl: string;
  cost: Model<Api>["cost"];
};

const MODEL_REQUEST = "agent.worker.model_request";
/** History kept by a forced compaction: about a quarter of this, so only the last turn stays. */
const COMPACTION_BUDGET_TOKENS = 4_000;
const EXCERPT = Array.from(
  { length: 120 },
  (_, line) => `${String(line).padStart(3, "0")} worker ${line % 7} wrote batch ${line * 13}`,
).join("\n");

/**
 * The newest catalog model for each pattern, where `*` stands for a dotted version:
 * `glm-*-flash` picks `glm-5.3-flash` over `glm-5.2-flash`.
 */
export function resolveModels(provider: string, patterns: string[]): MeasuredModel[] {
  const models = builtinModels().getModels(provider);
  return patterns.map((pattern) => {
    const [before, after, extra] = pattern.split("*");
    if (before === undefined || after === undefined || extra !== undefined)
      throw new Error(`Model pattern ${pattern} needs exactly one *`);
    const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^${literal(before)}(\\d+(?:\\.\\d+)*)${literal(after)}$`);
    const version = (id: string) => match.exec(id)?.[1]?.split(".").map(Number);
    const newest = models
      .filter((model) => version(model.id))
      .sort((a, b) => {
        const [left, right] = [version(a.id)!, version(b.id)!];
        for (let index = 0; index < Math.max(left.length, right.length); index++) {
          const order = (right[index] ?? 0) - (left[index] ?? 0);
          if (order) return order;
        }
        return 0;
      })[0];
    if (!newest) throw new Error(`No ${provider} catalog model matches ${pattern}`);
    const { id, api, baseUrl, cost } = newest;
    return { provider, id, api, baseUrl, cost };
  });
}

function turnsOf(scenario: ScenarioId, protocol: MeasureProtocol, trial: number): Turn[] {
  const shortest = Math.min(...protocol.gapsMs);
  switch (scenario) {
    case "chain": {
      // Rotating the order keeps a gap's effect apart from its position in the thread.
      const gaps = protocol.gapsMs.map(
        (_, index) => protocol.gapsMs[(index + trial) % protocol.gapsMs.length]!,
      );
      return [
        { waitMs: 0, prompt: "In one short sentence, what does a prompt cache save?" },
        ...gaps.map((waitMs) => ({ waitMs, prompt: "Add one more short sentence." })),
      ];
    }
    case "computer":
      return [
        {
          waitMs: 0,
          prompt:
            "Use the browser on your computer to open https://example.com and tell me its main heading.",
        },
        { waitMs: shortest, prompt: "Look at the screen again and say what changed, briefly." },
      ];
    case "approval":
      return protocol.approvalDelaysMs.map((approveAfterMs, index) => ({
        waitMs: 0,
        prompt: `Publish a note titled "Measurement ${index + 1}" with the publish_note tool, then confirm in one sentence.`,
        approveAfterMs,
      }));
    case "compaction":
      return [
        ...[1, 2, 3].map((part) => ({
          waitMs: 0,
          prompt: `Log excerpt ${part}. Summarize it in one line.\n${EXCERPT}`,
        })),
        { waitMs: 0, compact: true, prompt: "What did the three excerpts share? One sentence." },
        { waitMs: shortest, prompt: "And in one word?" },
      ];
  }
}

/** The note tool, with a per-thread nonce so no two threads share a tool catalog. */
const notes = (nonce: string): ConnectorProvider => ({
  describe: () => ({
    id: "notes",
    contractVersion: "1",
    adapterVersion: "1",
    capabilities: { discover: true, oauth: false, secretsBrokered: true },
  }),
  discoverTools: async () => [
    {
      name: "publish_note",
      description: `Notebook ${nonce}: publish a note with this title`,
      inputSchema: { type: "object", properties: { title: { type: "string" } } },
      route: { connectorId: "notes", resourceId: "notes", toolName: "publish_note" },
    },
  ],
  async *execute(request) {
    yield { type: "result", data: { published: request.args.title } };
  },
});
const RATE_LIMITED = /\b429\b|rate.?limit|too many requests/i;

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function requestRecord(event: LogEvent, sinceSameModelMs: number | null): RequestRecord {
  return {
    attemptId: String(event.attemptId),
    agent: String(event.agent),
    usageReported: event.usageReported === true,
    inputTokens: count(event.inputTokens),
    cacheReadTokens: count(event.cacheReadTokens),
    cacheWriteTokens: count(event.cacheWriteTokens),
    outputTokens: count(event.outputTokens),
    promptBytes: count(event.promptBytes),
    commonPrefixBytes: count(event.commonPrefixBytes),
    previousRequest: typeof event.previousRequest === "boolean" ? event.previousRequest : undefined,
    firstDivergingSection:
      typeof event.firstDivergingSection === "string" ? event.firstDivergingSection : null,
    sinceSameModelMs,
  };
}

/**
 * Drives every scenario thread through the real executor and worker routing, one thread at a
 * time, alternating which model goes first on each trial. Each thread gets a fresh controller
 * database and its own resources, released before the next one starts.
 */
export async function measureTokens(options: {
  models: MeasuredModel[];
  protocol: MeasureProtocol;
  upstream:
    | { apiKey: string }
    | {
        /** The protocol fixture's answers for one thread, offline. */
        script: (scenario: ScenarioId, model: MeasuredModel) => ModelEmulatorStep[];
      };
  provider: () => WorkerProvider & GuestConnector;
  /** The bot's computer; the fake one on local volumes by default. */
  sandbox?: () => SandboxProvider;
  /** Removes what the thread left on the deployment and counts what remains. */
  cleanup?: () => Promise<{ sandboxes: number; volumes: number }>;
  onThread?: (thread: ThreadRecord) => Promise<void>;
  /**
   * Trials of a scenario in flight per model, every model at once. Without it, one thread at a
   * time, which latency figures need.
   */
  inFlight?: number;
}): Promise<ThreadRecord[]> {
  const events: LogEvent[] = [];
  const previousLogger = getLogger();
  installLogger(
    createLogger({
      service: "worker-measure",
      sinks: [{ write: (event) => void (event.message === MODEL_REQUEST && events.push(event)) }],
    }),
  );
  const lastByModel = new Map<string, number>();
  // The controller sends every provider request, so its first body per thread shows which bytes
  // threads share; the tool catalog's nonce names the thread.
  const firstBodies = new Map<string, string>();
  const earlierBodies = new Map<string, string[]>();
  const providerFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const body = typeof init?.body === "string" ? init.body : undefined;
    const nonce = body && /Notebook ([0-9a-f]{8})/.exec(body)?.[1];
    if (nonce && !firstBodies.has(nonce)) firstBodies.set(nonce, body);
    return providerFetch(input, init);
  };
  const threads: ThreadRecord[] = [];
  try {
    const measure = async (scenario: ScenarioId, model: MeasuredModel, trial: number) => {
      const thread = await measureThread(scenario, model, trial);
      threads.push(thread);
      await options.onThread?.(thread);
    };
    if (options.inFlight) {
      const inFlight = options.inFlight;
      // Each model's provider cache is its own, and each thread's prompt carries its own nonce.
      await Promise.all(
        options.models.map(async (model) => {
          for (const scenario of options.protocol.scenarios) {
            let next = 0;
            await Promise.all(
              Array.from({ length: inFlight }, async () => {
                while (next < options.protocol.trials) {
                  const trial = next++;
                  for (let retry = 0; ; retry++) {
                    const thread = await measureThread(scenario, model, trial);
                    const limited = [thread.error, ...thread.turns.map((turn) => turn.error)].some(
                      (error) => error !== undefined && RATE_LIMITED.test(error),
                    );
                    if (!limited || retry === 3) {
                      threads.push({ ...thread, ...(retry ? { rateLimitRetries: retry } : {}) });
                      await options.onThread?.(threads.at(-1)!);
                      break;
                    }
                    await sleep(30_000 * 2 ** retry);
                  }
                }
              }),
            );
          }
        }),
      );
    } else {
      for (const scenario of options.protocol.scenarios) {
        for (let trial = 0; trial < options.protocol.trials; trial++) {
          for (let index = 0; index < options.models.length; index++)
            await measure(
              scenario,
              options.models[(index + trial) % options.models.length]!,
              trial,
            );
        }
      }
    }
  } finally {
    installLogger(previousLogger);
    globalThis.fetch = providerFetch;
  }
  return threads;

  async function measureThread(
    scenario: ScenarioId,
    model: MeasuredModel,
    trial: number,
  ): Promise<ThreadRecord> {
    const seen: Seen[] = [];
    const ensures: number[] = [];
    const nonce = randomBytes(4).toString("hex");
    const log = queryLog();
    const run = await startWorkerRun({
      steps: "script" in options.upstream ? options.upstream.script(scenario, model) : [],
      catalogModel: {
        provider: model.provider,
        id: model.id,
        ...("apiKey" in options.upstream ? { apiKey: options.upstream.apiKey } : {}),
      },
      tools: notes(nonce),
      prisma: log.wrap,
      computerScope: scenario === "computer" ? "dedicated" : "none",
      sandbox: options.sandbox?.(),
      screensByPath: true,
      provider: () => {
        const base = options.provider();
        return forward(base, {
          async ensure(spec, ctx) {
            ensures.push(performance.now());
            return base.ensure(spec, ctx);
          },
        });
      },
      connector: (provider) => tapConnector(provider, seen, []),
    });
    const record: ThreadRecord = { scenario, model: model.id, trial, nonce, turns: [] };
    try {
      await run.prisma.actionApprovalRule.create({
        data: {
          spaceId: run.spaceId,
          createdByUserId: run.userId,
          effect: "require_approval",
          matchKind: "tool",
          matchValue: "publish_note",
        },
      });
      for (const [index, turn] of turnsOf(scenario, options.protocol, trial).entries()) {
        if (index > 0) await sleep(turn.waitMs);
        const own = () => events.filter((event) => event.threadId === run.thread.id);
        const from = own().length;
        const startedAt = performance.now();
        let compactionMs: number | undefined;
        if (turn.compact) {
          await run.compactHistory(COMPACTION_BUDGET_TOKENS);
          compactionMs = Math.round(performance.now() - startedAt);
        }
        const runId = await run.send(turn.prompt);
        await run.continueRun(runId);
        const row = () =>
          run.prisma.run.findUniqueOrThrow({
            where: { id: runId },
            select: { status: true, error: true },
          });
        let outcome = await row();
        let settledStatus = outcome.status;
        const approvalRequested = settledStatus === "waiting_input";
        let restoreOutsideProvisioningMs: number | null | undefined;
        let provisioningMs: number | undefined;
        if (approvalRequested && turn.approveAfterMs !== undefined) {
          await sleep(turn.approveAfterMs);
          const card = await latestCard(run.prisma, runId);
          await run.events.answerRunInput({
            spaceId: run.spaceId,
            threadId: run.thread.id,
            runId,
            messageId: card.id,
            answeredByUserId: run.userId,
            answer: "allow",
          });
          const answeredAt = performance.now();
          await run.continueRun(runId);
          outcome = await row();
          settledStatus = outcome.status;
          const after = parse(seen).filter((frame) => frame.at >= answeredAt);
          const ensureAt = ensures.find((at) => at >= answeredAt);
          const helloAt = after.find((frame) => frame.kind === "worker.hello")?.at;
          const requestAt = after.find(
            (frame) => frame.from === "guest" && frame.type === "model.request",
          )?.at;
          if (ensureAt !== undefined && helloAt !== undefined)
            provisioningMs = Math.round(helloAt - ensureAt);
          restoreOutsideProvisioningMs =
            provisioningMs === undefined || requestAt === undefined
              ? null
              : Math.round(requestAt - answeredAt - provisioningMs);
        }
        const frames = parse(seen).filter((frame) => frame.at >= startedAt);
        record.turns.push({
          waitMs: index > 0 ? turn.waitMs : 0,
          ...(turn.approveAfterMs === undefined ? {} : { approveAfterMs: turn.approveAfterMs }),
          compacted: turn.compact === true,
          ...(compactionMs === undefined ? {} : { compactionMs }),
          status: settledStatus,
          ...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}),
          approvalRequested,
          ...(restoreOutsideProvisioningMs === undefined ? {} : { restoreOutsideProvisioningMs }),
          ...(provisioningMs === undefined ? {} : { provisioningMs }),
          appends: settled(frames, "transcript", "recorded").map(({ from: at, to }) => ({
            ms: Math.round((to - at) * 10) / 10,
            queries: log.within(at, to).count,
          })),
          requests: own()
            .slice(from)
            .map((event) => {
              const at = Date.parse(event.timestamp);
              const previous = lastByModel.get(model.id);
              lastByModel.set(model.id, at);
              return requestRecord(event, previous === undefined ? null : at - previous);
            }),
        });
      }
      run.model.assertComplete();
    } catch (error) {
      // One failed exchange must not end hours of measurement; the receipt keeps why.
      record.error = error instanceof Error ? error.message.slice(0, 500) : String(error);
    } finally {
      await run.close();
      const left = await options.cleanup?.();
      if (left) record.left = left;
    }
    const body = firstBodies.get(nonce);
    if (body) {
      firstBodies.delete(nonce);
      record.cacheMarkersSent = body.includes('"cache_control"');
      const earlier = earlierBodies.get(model.id) ?? [];
      const shared = (other: string) => {
        let index = 0;
        while (index < other.length && other[index] === body[index]) index++;
        return index;
      };
      if (earlier.length > 0)
        record.sharedBase = {
          sharedChars: Math.max(...earlier.map(shared)),
          bodyChars: body.length,
          nonceAt: body.indexOf(nonce),
          toolsAt: body.indexOf('"tools":'),
        };
      earlierBodies.set(model.id, [...earlier, body]);
    }
    return record;
  }
}
