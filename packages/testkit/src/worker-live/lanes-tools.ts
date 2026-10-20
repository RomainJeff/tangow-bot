import { existsSync, readFileSync } from "node:fs";
import { toolResult } from "../file-task.js";
import type { ModelEmulatorRequest } from "../model-emulator.js";
import { HOSTILE_GUEST_BUILD } from "./hostile-guest-build.js";
import { call, finish, liveRun, recap, toolNames } from "./run.js";
import type { Lane } from "./session.js";

export const laneD: Lane = {
  id: "d",
  issue: "outil désactivé parent/helper",
  scenario: "A run disables native write and bash; the parent and a helper each try both tools",
  passWhen:
    "Neither the parent's nor the helper's tool list offers it, each call returns an error to its model, and no call of it reaches the controller",
  async run(live) {
    const seen: Record<string, unknown> = {};
    const isHelper = (request: ModelEmulatorRequest) =>
      JSON.stringify(request.messages[0]?.content ?? "").includes("Rakazo subagent");
    const worker = await liveRun(live, {
      workers: (workers) => ({
        ...workers,
        runtime(launch) {
          const runtime = workers.runtime(launch);
          return {
            ...runtime,
            describe() {
              const descriptor = runtime.describe();
              return {
                ...descriptor,
                capabilities: {
                  ...descriptor.capabilities,
                  localTools: descriptor.capabilities.localTools?.filter(
                    (tool) => !["write", "bash"].includes(tool.name),
                  ),
                },
              };
            },
          };
        },
      }),
      steps: [
        call("p1", "write", { path: "disabled.txt", content: "forbidden" }, (request) => {
          seen.parentTools = toolNames(request);
        }),
        call("p-bash", "bash", { command: "echo forbidden" }, (request) => {
          seen.parentResult = toolResult(request);
        }),
        call("p2", "run_subagent", { name: "helper", task: "Try write and bash." }, (request) => {
          seen.parentBashResult = toolResult(request);
        }),
        call("h1", "write", { path: "disabled.txt", content: "forbidden" }, (request) => {
          seen.helperIsHelper = isHelper(request);
          seen.helperTools = toolNames(request);
        }),
        call("h-bash", "bash", { command: "echo forbidden" }, (request) => {
          seen.helperResult = toolResult(request);
        }),
        {
          expect(request) {
            seen.helperBashResult = toolResult(request);
          },
          response: { type: "text", text: "The native tools are disabled." },
        },
        ...finish("Tried a disabled tool", (request) => {
          seen.parentAfterHelper = toolResult(request);
        }),
      ],
    });
    try {
      const runId = await worker.send("Try the disabled native tools.");
      await worker.completed(runId);
      const calledAtController = worker.seen
        .filter((frame) => frame.from === "guest")
        .map(
          (frame) =>
            JSON.parse(Buffer.from(frame.frame).toString()) as {
              payload?: { body?: { type?: string; name?: string } };
            },
        )
        .filter((message) => message.payload?.body?.type === "tool.call")
        .map((message) => message.payload?.body?.name);
      const effects = await worker.run.prisma.externalEffect.findMany({
        where: { runId, kind: { in: ["write", "bash"] } },
      });
      const parentTools = seen.parentTools as string[];
      const helperTools = seen.helperTools as string[];
      const pass =
        (await worker.status(runId)) === "completed" &&
        parentTools.includes("run_subagent") &&
        parentTools.includes("read") &&
        !parentTools.includes("write") &&
        !parentTools.includes("bash") &&
        seen.helperIsHelper === true &&
        helperTools.length > 0 &&
        helperTools.includes("read") &&
        !helperTools.includes("write") &&
        !helperTools.includes("bash") &&
        String(seen.parentResult).toLowerCase().includes("not found") &&
        String(seen.helperResult).toLowerCase().includes("not found") &&
        !calledAtController.includes("write") &&
        !calledAtController.includes("bash") &&
        effects.length === 0 &&
        String(seen.parentBashResult).toLowerCase().includes("not found") &&
        String(seen.helperBashResult).toLowerCase().includes("not found");
      return {
        pass,
        observed: {
          parentOffersWrite: parentTools.includes("write"),
          parentOffersBash: parentTools.includes("bash"),
          helperOffersWrite: helperTools.includes("write"),
          helperOffersBash: helperTools.includes("bash"),
          helperToolCount: helperTools.length,
          parentResult: seen.parentResult,
          helperResult: seen.helperResult,
          toolCallsAtController: calledAtController,
          disabledToolEffects: effects.length,
          note: "The guest's Pi answers a call of a tool it was not given without asking the controller. A guest that asks anyway is refused with unknown_tool, which runtime-worker-hostile.test.ts proves offline.",
        },
      };
    } finally {
      await worker.close();
    }
  },
};

const MODEL_KEY = "worker-fixture-model-key";

export const laneE: Lane = {
  id: "e-openai",
  issue: "proxy OpenAI simulé",
  scenario:
    "An OpenAI-protocol model behind the controller's relay; the guest looks for the model key in its environment and every process's",
  passWhen:
    "The run completes through the relay with the controller's key while no guest process holds it",
  async run(live) {
    let found = "";
    const worker = await liveRun(live, {
      steps: [
        call("k1", "bash", {
          command: `env | grep -c '${MODEL_KEY}'; cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c '${MODEL_KEY}'; true`,
        }),
        ...finish("Looked for the key", (request) => {
          found = toolResult(request);
        }),
      ],
    });
    try {
      const runId = await worker.send("Look for the key.");
      await worker.completed(runId);
      const counts = found
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const relayed = worker.frames().filter((frame) => frame.type === "model.request").length;
      return {
        pass:
          (await worker.status(runId)) === "completed" &&
          counts.join(",") === "0,0" &&
          relayed >= 3,
        observed: {
          keyInGuestEnv: counts[0],
          keyInAnyGuestProcessEnviron: counts[1],
          modelRequestsRelayed: relayed,
          note: "The model emulator asserts the controller's bearer key on every call, so each relayed call carried it.",
        },
      };
    } finally {
      await worker.close();
    }
  },
};

export const laneEAnthropic: Lane = {
  id: "e-anthropic",
  issue: "proxy Anthropic simulé",
  scenario:
    "A catalog Anthropic model billed with a plain API key, its Messages API emulated behind the controller's relay, with a thinking block and a tool call; the guest looks for the key as in e-openai",
  passWhen:
    "The run completes through the relay on the Anthropic protocol with the controller's key while no guest process holds it, and the tool result reaches the model",
  async run(live) {
    let found = "";
    const worker = await liveRun(live, {
      protocol: "anthropic",
      steps: [
        call("k1", "bash", {
          command: `env | grep -c '${MODEL_KEY}'; cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c '${MODEL_KEY}'; true`,
        }),
        call("say", "message_user", { message: "Done." }, (request) => {
          found = toolResult(request);
        }),
        {
          expect() {},
          response: {
            type: "text",
            thinking: "The key was not in the guest.",
            text: recap("Looked for the key"),
            usage: { promptTokens: 210, completionTokens: 12, cacheReadTokens: 64 },
          },
        },
      ],
    });
    try {
      const runId = await worker.send("Look for the key.");
      await worker.completed(runId);
      const counts = found
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const relayed = worker.frames().filter((frame) => frame.type === "model.request").length;
      const requests = worker.run.model.requests;
      const usage = await worker.run.prisma.run.findUniqueOrThrow({
        where: { id: runId },
        select: { modelProvider: true, modelId: true },
      });
      return {
        pass:
          (await worker.status(runId)) === "completed" &&
          counts.join(",") === "0,0" &&
          relayed >= 3 &&
          requests.length === 3 &&
          usage.modelProvider === "anthropic",
        observed: {
          keyInGuestEnv: counts[0],
          keyInAnyGuestProcessEnviron: counts[1],
          modelRequestsRelayed: relayed,
          anthropicRequestsServed: requests.length,
          runModel: `${usage.modelProvider}/${usage.modelId}`,
          note: "The emulator serves /v1/messages and asserts the controller's x-api-key on every call; the catalog model points at it for the run only.",
        },
      };
    } finally {
      await worker.close();
    }
  },
};

/** Where the refusal lane writes the hand-written guest in each worker VM. */
const HOSTILE_GUEST = "/tmp/rakazo-hostile-guest.mjs";

/**
 * The hand-written guest: the copy the live bundle carries beside it, or, from source, a bundle
 * built now. esbuild is a development dependency only, so it loads only on that path.
 */
async function hostileGuestScript(): Promise<string> {
  const beside = new URL("../guest/hostile-guest.mjs", import.meta.url);
  if (existsSync(beside)) return readFileSync(beside, "utf8");
  const { build } = await import("esbuild");
  const built = await build({ ...HOSTILE_GUEST_BUILD, write: false });
  const text = built.outputFiles?.[0]?.text;
  if (!text) throw new Error("esbuild wrote no hostile guest");
  return text;
}

export const laneERefusals: Lane = {
  id: "e-refusals",
  issue: "refus connexion/modèle/endpoint interdits",
  scenario:
    "A hand-written guest in the worker VM asks the relay for a model call naming its own model, endpoint and key, and, in a second run, calls a tool the run does not expose",
  passWhen:
    "Each run fails as a protocol breach, the upstream model is never called, the unknown tool is refused, and the attempt's VM is released",
  async run(live) {
    const script = await hostileGuestScript();
    const attempt = async (request: "model_target" | "unknown_tool") => {
      const worker = await liveRun(live, {
        steps: [],
        provider: () =>
          live.workerProvider(undefined, { path: HOSTILE_GUEST, script, args: request }),
      });
      try {
        const runId = await worker.send("Do the thing.");
        const row = await worker.run.prisma.run.findUniqueOrThrow({
          where: { id: runId },
          select: { status: true, error: true },
        });
        const frames = worker.frames();
        return {
          status: row.status,
          error: row.error,
          upstreamCalls: worker.run.model.requests.length,
          guestSent: frames
            .filter((frame) => frame.from === "guest")
            .map((frame) => frame.type ?? frame.kind),
          controllerSent: frames
            .filter((frame) => frame.from === "controller")
            .map((frame) => frame.type ?? frame.kind),
          attempts: await worker.attempts(runId),
        };
      } finally {
        await worker.close();
      }
    };
    const modelTarget = await attempt("model_target");
    const unknownTool = await attempt("unknown_tool");
    const released = (result: typeof modelTarget) =>
      result.attempts.length > 0 && result.attempts.every((row) => row.workerState === "released");
    const pass =
      modelTarget.status === "failed" &&
      modelTarget.error?.includes("broke the run protocol: invalid") === true &&
      modelTarget.upstreamCalls === 0 &&
      modelTarget.guestSent.includes("model.request") &&
      !modelTarget.controllerSent.includes("model.event") &&
      released(modelTarget) &&
      unknownTool.status === "failed" &&
      unknownTool.error?.includes("broke the run protocol: unknown_tool") === true &&
      unknownTool.upstreamCalls === 0 &&
      unknownTool.controllerSent.includes("refused") &&
      released(unknownTool);
    return { pass, observed: { modelTarget, unknownTool } };
  },
};
