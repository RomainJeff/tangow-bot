import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";
import { modelsForRequest, reliableStreamOptions } from "./pi-run-model.js";
import type { WireFixture, WireRequest, WireStep } from "./pi-sdk-proof-support.js";
import { createProofSession, proofModelRuntime, startWireFixture } from "./pi-sdk-proof-support.js";

const { values } = parseArgs({
  options: { trials: { type: "string", default: "30" }, out: { type: "string" } },
});
const trials = Number(values.trials);
if (!Number.isInteger(trials) || trials < 1) throw new Error("--trials must be a positive integer");

const KEY = "bench-key";
const MODEL_ID = "proof-model";
const BUDGET = 1.2;
const SETTLE_MS = 5_000;
const COLD_IMPORTS = {
  agent: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-ai/providers/all",
  ],
  sdk: ["@earendil-works/pi-coding-agent"],
};
const METRICS = ["twoIndependentRuns", "construct", "firstRun", "warmRun", "abort"] as const;
const ROLES = {
  twoIndependentRuns: "budget",
  abort: "settle",
  construct: "descriptive",
  firstRun: "diagnostic",
  warmRun: "diagnostic",
} as const satisfies Record<Metric, "budget" | "settle" | "descriptive" | "diagnostic">;

type Engine = "agent" | "sdk";
type Metric = (typeof METRICS)[number];
interface Instance {
  route: string;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  lastText(): string;
  dispose(): void;
}

function expectRequest(request: WireRequest, transcript: string[]) {
  assert.equal(request.credential, KEY);
  assert.deepEqual(request.tools, ["lookup"]);
  assert.deepEqual(request.schemas, { lookup: { type: "object", properties: {} } });
  assert.ok(request.transcript[0]?.startsWith("system: Bench system."));
  assert.deepEqual(request.transcript.slice(1), transcript);
}

const turn = (final: string, prior: string[] = []): WireStep[] => [
  (request) => {
    expectRequest(request, [...prior, `user: ${final}`]);
    return {
      type: "message",
      blocks: [{ type: "tool", id: `call-${final}`, name: "lookup", arguments: {} }],
    };
  },
  (request) => {
    expectRequest(request, [
      ...prior,
      `user: ${final}`,
      `call call-${final} lookup {}`,
      `tool call-${final}: looked`,
    ]);
    return { type: "message", blocks: [{ type: "text", text: final }] };
  },
];

async function construct(
  engine: Engine,
  wire: WireFixture,
  cwd: string,
  effects: string[],
): Promise<Instance> {
  const execute = async () => {
    effects.push("lookup");
    return { content: [{ type: "text" as const, text: "looked" }], details: {} };
  };
  const lookup = { name: "lookup", label: "lookup", description: "lookup", execute };
  if (engine === "agent") {
    const models = modelsForRequest(
      { model: { provider: OPENAI_COMPATIBLE_PROVIDER_ID, id: MODEL_ID, baseUrl: wire.baseUrl } },
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, MODEL_ID);
    if (!model) throw new Error("openai-compatible fixture model did not resolve");
    const tool: AgentTool = { ...lookup, parameters: Type.Object({}) };
    const agent = new Agent({
      streamFn: (m, context, options) =>
        models.streamSimple(m, context, reliableStreamOptions(m, options)),
      getApiKey: async () => KEY,
      initialState: {
        systemPrompt: "Bench system.",
        model,
        thinkingLevel: "off",
        tools: [tool],
        messages: [],
      },
    });
    return {
      route: `${model.provider}/${model.api} with reliableStreamOptions`,
      prompt: async (text) => {
        await agent.prompt(text);
        await agent.waitForIdle();
      },
      abort: async () => {
        agent.abort();
        await agent.waitForIdle();
      },
      lastText: () => assistantText(agent.state.messages.at(-1)),
      dispose: () => agent.abort(),
    };
  }
  const runtime = await proofModelRuntime(wire, KEY);
  const tool: ToolDefinition = { ...lookup, parameters: Type.Object({}) };
  const session: AgentSession = await createProofSession({
    cwd,
    agentDir: cwd,
    runtime,
    systemPrompt: "Bench system.",
    tools: [tool],
  });
  return {
    route: `${runtime.model.provider}/${runtime.model.api} with SDK stream options`,
    prompt: async (text) => {
      await session.prompt(text, { expandPromptTemplates: false });
      await session.agent.waitForIdle();
    },
    abort: () => session.abort(),
    lastText: () => session.getLastAssistantText() ?? "",
    dispose: () => session.dispose(),
  };
}

function assistantText(message: Agent["state"]["messages"][number] | undefined) {
  if (message?.role !== "assistant") return "";
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function expectAnswer(engine: Engine, instance: Instance, expected: string) {
  if (instance.lastText() !== expected) {
    throw new Error(`${engine} answered "${instance.lastText()}"`);
  }
}

async function within<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} exceeded ${SETTLE_MS}ms`)), SETTLE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function timed<T>(work: () => Promise<T>): Promise<[number, T]> {
  const started = performance.now();
  const result = await work();
  return [performance.now() - started, result];
}

async function independentRuns(engine: Engine, cwd: string) {
  const wire = await startWireFixture({
    protocol: "openai-completions",
    steps: [...turn("first"), ...turn("second")],
  });
  const effects: string[] = [];
  const instances: Instance[] = [];
  try {
    const [ms] = await timed(async () => {
      for (const prompt of ["first", "second"]) {
        const instance = await construct(engine, wire, cwd, effects);
        instances.push(instance);
        await instance.prompt(prompt);
        expectAnswer(engine, instance, prompt);
      }
    });
    wire.assertComplete();
    assert.deepEqual(effects, ["lookup", "lookup"]);
    return ms;
  } finally {
    for (const instance of instances) instance.dispose();
    await wire.close();
  }
}

async function sameInstance(engine: Engine, cwd: string) {
  let requested!: () => void;
  const holdRequested = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const wire = await startWireFixture({
    protocol: "openai-completions",
    steps: [
      ...turn("first"),
      ...turn("second", [
        "user: first",
        "call call-first lookup {}",
        "tool call-first: looked",
        "assistant: first",
      ]),
      () => {
        requested();
        return { type: "hold", blocks: [{ type: "text", text: "partial" }] };
      },
    ],
  });
  const effects: string[] = [];
  try {
    const [construct_, instance] = await timed(() => construct(engine, wire, cwd, effects));
    try {
      const [firstRun] = await timed(() => instance.prompt("first"));
      expectAnswer(engine, instance, "first");
      const [warmRun] = await timed(() => instance.prompt("second"));
      expectAnswer(engine, instance, "second");
      const held = instance.prompt("hold");
      await within(
        Promise.race([
          holdRequested,
          held.then(() => {
            throw new Error(`${engine} held run settled before abort`);
          }),
        ]),
        `${engine} held request`,
      );
      const [abort] = await timed(() =>
        within(
          instance.abort().then(() => held),
          `${engine} abort`,
        ),
      );
      wire.assertComplete();
      assert.deepEqual(effects, ["lookup", "lookup"]);
      return { route: instance.route, construct: construct_, firstRun, warmRun, abort };
    } finally {
      instance.dispose();
    }
  } finally {
    await wire.close();
  }
}

async function trial(engine: Engine, cwd: string) {
  const twoIndependentRuns = await independentRuns(engine, cwd);
  const { route, ...metrics } = await sameInstance(engine, cwd);
  return { route, metrics: { twoIndependentRuns, ...metrics } satisfies Record<Metric, number> };
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const median =
    sorted.length % 2
      ? (sorted[Math.floor(mid)] ?? 0)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    median: round(median),
    min: round(sorted[0] ?? 0),
    max: round(sorted.at(-1) ?? 0),
    samples: samples.map(round),
  };
}

function verdict(
  metric: Metric,
  agent: ReturnType<typeof summarize>,
  sdk: ReturnType<typeof summarize>,
  ratio: number | null,
) {
  const role = ROLES[metric];
  switch (role) {
    case "budget":
      if (errors.length || ratio === null) return "inconclusive";
      return ratio <= BUDGET ? "within" : "over";
    case "settle":
      if (errors.length) return "inconclusive";
      return Math.max(agent.max, sdk.max) < SETTLE_MS ? "within" : "over";
    case "descriptive":
    case "diagnostic":
      return role;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

const execFileAsync = promisify(execFile);
const adaptersDir = join(dirname(fileURLToPath(import.meta.url)), "..");

async function coldImport(specifiers: readonly string[]) {
  const script = `const t = performance.now(); for (const s of ${JSON.stringify(specifiers)}) await import(s); process.stdout.write(String(performance.now() - t));`;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: adaptersDir,
    timeout: 30_000,
  });
  const ms = Number(stdout);
  if (!Number.isFinite(ms)) throw new Error(`cold import printed "${stdout}"`);
  return ms;
}

const samples: Record<Engine, Record<Metric, number[]>> = {
  agent: { twoIndependentRuns: [], construct: [], firstRun: [], warmRun: [], abort: [] },
  sdk: { twoIndependentRuns: [], construct: [], firstRun: [], warmRun: [], abort: [] },
};
const routes: Record<Engine, string> = { agent: "unobserved", sdk: "unobserved" };
const importSamples: Record<Engine, number[]> = { agent: [], sdk: [] };
const errors: string[] = [];
const cwd = await mkdtemp(join(tmpdir(), "pi-sdk-bench-"));
try {
  for (const engine of ["agent", "sdk"] as const) await trial(engine, cwd);
  for (let index = 0; index < trials; index += 1) {
    const order: Engine[] = index % 2 ? ["sdk", "agent"] : ["agent", "sdk"];
    for (const engine of order) {
      try {
        const result = await trial(engine, cwd);
        routes[engine] = result.route;
        for (const metric of METRICS) samples[engine][metric].push(result.metrics[metric]);
        importSamples[engine].push(await coldImport(COLD_IMPORTS[engine]));
      } catch (error) {
        errors.push(
          `${engine} trial ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}

const sdkPackage = z
  .object({ version: z.string() })
  .parse(
    JSON.parse(
      await readFile(
        join(
          dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
          "../package.json",
        ),
        "utf8",
      ),
    ),
  );
const metrics = Object.fromEntries(
  METRICS.map((metric) => {
    const agent = summarize(samples.agent[metric]);
    const sdk = summarize(samples.sdk[metric]);
    const ratio = agent.median > 0 ? Math.round((sdk.median / agent.median) * 1000) / 1000 : null;
    const deltaMs = Math.round((sdk.median - agent.median) * 1000) / 1000;
    return [
      metric,
      {
        role: ROLES[metric],
        agent,
        sdk,
        deltaMs,
        sdkOverAgent: ratio,
        verdict: verdict(metric, agent, sdk, ratio),
      },
    ];
  }),
);
const report = {
  comparison: {
    engines: "bare pi-agent-core Agent (current engine construction) vs hermetic SDK AgentSession",
    providerPath: {
      agent: routes.agent,
      sdk: routes.sdk,
      note: "the engines reach the loopback through different pi-ai provider registrations and stream options; every request is checked against the same credential, tool schema and literal transcript, so the wire contract matches but provider-side request shaping does not",
    },
  },
  script:
    "openai-completions loopback; twoIndependentRuns builds a fresh instance per tool+text run, the diagnostic instance runs two turns then aborts a held stream",
  metricScope: {
    process:
      "all engine metrics run in one process after module import and an untimed warmup trial per engine; they are not cold boot",
    twoIndependentRuns: `primary: construction plus one tool+text run on each of two fresh instances, through settlement; budget sdk median <= ${BUDGET}x agent median`,
    abort: `held stream abort through settlement; criterion every sample under ${SETTLE_MS} ms`,
    construct: "descriptive: diagnostic instance construction",
    firstRun: "diagnostic: first run on the diagnostic instance",
    warmRun: "diagnostic: warm second turn on the same instance, not a product per-run benchmark",
  },
  sdkVersion: sdkPackage.version,
  node: process.version,
  platform: `${platform()}-${arch()}`,
  cpus: cpus().length,
  trials,
  budget: BUDGET,
  errors,
  metrics,
  coldImport: {
    scope:
      "fresh Node process per sample, import only; module sets differ in capability, so no ratio or verdict",
    agent: { modules: COLD_IMPORTS.agent, ...summarize(importSamples.agent) },
    sdk: { modules: COLD_IMPORTS.sdk, ...summarize(importSamples.sdk) },
  },
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (values.out) await writeFile(values.out, json);
process.stdout.write(json);
if (errors.length) process.exitCode = 1;
