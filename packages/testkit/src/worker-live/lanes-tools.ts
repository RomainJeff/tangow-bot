import { toolResult } from "../file-task.js";
import type { ModelEmulatorRequest } from "../model-emulator.js";
import { call, finish, liveRun, toolNames } from "./run.js";
import type { Lane } from "./session.js";

export const laneD: Lane = {
  id: "d",
  issue: "outil désactivé parent/helper",
  scenario:
    "A run whose model cannot see images, so computer_act is not one of its tools; the parent and a helper each call it",
  passWhen:
    "Neither the parent's nor the helper's tool list offers it, each call returns an error to its model, and no call of it reaches the controller",
  async run(live) {
    const seen: Record<string, unknown> = {};
    const isHelper = (request: ModelEmulatorRequest) =>
      JSON.stringify(request.messages[0]?.content ?? "").includes("Rakazo subagent");
    const worker = await liveRun(live, {
      steps: [
        call("p1", "computer_act", { action: "click", x: 1, y: 1 }, (request) => {
          seen.parentTools = toolNames(request);
        }),
        call("p2", "run_subagent", { name: "helper", task: "Click the screen." }, (request) => {
          seen.parentResult = toolResult(request);
        }),
        call("h1", "computer_act", { action: "click", x: 1, y: 1 }, (request) => {
          seen.helperIsHelper = isHelper(request);
          seen.helperTools = toolNames(request);
        }),
        {
          expect(request) {
            seen.helperResult = toolResult(request);
          },
          response: { type: "text", text: "The click tool is not available." },
        },
        ...finish("Tried a disabled tool", (request) => {
          seen.parentAfterHelper = toolResult(request);
        }),
      ],
    });
    try {
      const runId = await worker.send("Click the screen.");
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
        where: { runId, kind: "computer_act" },
      });
      const parentTools = seen.parentTools as string[];
      const helperTools = seen.helperTools as string[];
      const pass =
        (await worker.status(runId)) === "completed" &&
        parentTools.includes("run_subagent") &&
        !parentTools.includes("computer_act") &&
        seen.helperIsHelper === true &&
        helperTools.length > 0 &&
        !helperTools.includes("computer_act") &&
        String(seen.parentResult).toLowerCase().includes("not found") &&
        String(seen.helperResult).toLowerCase().includes("not found") &&
        !calledAtController.includes("computer_act") &&
        effects.length === 0;
      return {
        pass,
        observed: {
          parentOffersComputerAct: parentTools.includes("computer_act"),
          helperOffersComputerAct: helperTools.includes("computer_act"),
          helperToolCount: helperTools.length,
          parentResult: seen.parentResult,
          helperResult: seen.helperResult,
          toolCallsAtController: calledAtController,
          computerActEffects: effects.length,
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
