import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { GuestImage, ReplyFinal } from "@rakazo/adapter-kit";
import { guestRuntimeModel } from "@rakazo/adapters/pi-runtime";
import {
  piAiProviderStream,
  projectPiAi,
  relayedModel,
} from "@rakazo/adapters/runtime-worker/pi-ai";
import { skillReadName } from "@rakazo/adapters/volume-skills";
import type { DoneBody, GuestHarness, HarnessHost } from "../harness.js";
import { relayModelRuntime } from "./pi-session.js";
import { piToolManifest } from "./pi-tools.js";

type SteeringMessage = Extract<ReplyFinal, { type: "steering" }>["messages"][number];

function stopIfCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new Error("The run was cancelled");
}

function piImages(images: readonly GuestImage[]) {
  return images.map((image) => ({
    type: "image" as const,
    data: image.data,
    mimeType: image.mimeType,
  }));
}

/** Pi's defaults, but for what the worker changes. */
const PI_SETTINGS = {
  // Warming sends requests nobody asked for; through the relay they would cost the run.
  cacheWarming: "off" as const,
  // Resizing needs Pi's image wasm, which the single-file guest bundle does not ship.
  images: { autoResize: false },
  // Every claimed steering message must reach the model in this attempt, not one per turn.
  steeringMode: "all" as const,
};

/** Rakazo's hooks into Pi's own loop. Pi awaits each one, so the channel paces the loop. */
function rakazoExtension(
  host: HarnessHost,
  cwd: string,
  steer: (message: SteeringMessage) => void,
) {
  const seenIds: string[] = [];
  return (pi: ExtensionAPI) => {
    pi.on("message_update", async (event) => {
      if (event.assistantMessageEvent.type === "text_delta") {
        await host.emit({ type: "text", text: event.assistantMessageEvent.delta });
      }
    });
    pi.on("tool_execution_start", async (event) => {
      const args = JSON.stringify(event.args ?? {});
      await host.emit({
        type: "progress",
        text: `${event.toolName} ${args.length > 160 ? `${args.slice(0, 160)}…` : args}`,
        activity: true,
      });
    });
    pi.on("tool_result", async (event) => {
      if (event.toolName !== "read" || event.isError) return;
      const name = await skillReadName(cwd, event.input.path);
      if (name) await host.decide({ type: "skills.used", name }, "recorded");
    });
    pi.on("turn_end", async (event) => {
      // Only a turn the loop goes on from: a claimed message must reach the model in this attempt.
      if (event.toolResults.length === 0) return;
      const reply = await host.decide(
        { type: "steering.claim", seenIds: [...seenIds] },
        "steering",
      );
      for (const message of reply.messages) {
        seenIds.push(message.id);
        steer(message);
      }
    });
  };
}

/**
 * Pi with its own loop, prompt, tools, retries and compaction. The VM is the boundary: the file
 * and shell tools run here without a grant. Every model call goes through the controller's relay.
 */
export const piNativeHarness: GuestHarness = {
  declaration: { name: "pi-native", capabilities: ["native-loop", "steering"] },
  nativeTools: piToolManifest(),
  async executeNativeTool() {
    throw new Error("pi-native runs its own tools");
  },

  async run({ run, cwd, skillsDir }, host): Promise<DoneBody> {
    stopIfCancelled(host.signal);
    const model = guestRuntimeModel(relayedModel(run.model));
    const modelRuntime = await relayModelRuntime(
      model,
      piAiProviderStream((body, onPart, signal) => host.model(body, onPart, signal)),
    );
    // Pi's config home for this attempt only: nothing from the image or an earlier run loads.
    const agentDir = await mkdtemp(path.join(tmpdir(), "rakazo-pi-"));
    // One untrusted, in-memory settings store: no settings file is read, the volume's least of all.
    const settingsManager = SettingsManager.inMemory(PI_SETTINGS, {
      projectTrusted: false,
    });
    let session: AgentSession | undefined;
    try {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noSkills: true,
        additionalSkillPaths: [skillsDir],
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          rakazoExtension(host, cwd, (message) =>
            session?.agent.steer({
              role: "user",
              content: [{ type: "text", text: message.text }, ...piImages(message.images ?? [])],
              timestamp: Date.now(),
            }),
          ),
        ],
        appendSystemPromptOverride: () => [run.instructions],
      });
      // A bot's volume is not a trusted project: its `.pi/` never loads.
      await loader.reload({ resolveProjectTrust: async () => false });

      const sessionManager = SessionManager.inMemory(cwd);
      const controllerTools = run.tools.filter((tool) => tool.where === "controller");
      for (const message of projectPiAi(
        run.history,
        run.prompt,
        model,
        controllerTools.map((tool) => tool.name),
        run.sourceMessageId,
      )) {
        sessionManager.appendMessage(message);
      }

      ({ session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        model,
        thinkingLevel: run.model.thinkingLevel ?? undefined,
        resourceLoader: loader,
        sessionManager,
        settingsManager,
        tools: run.tools.filter((tool) => tool.where === "guest").map((tool) => tool.name),
      }));
      const active = session;

      // What the attempt adds, in order: the controller ingests it into canonical history.
      const added: Array<{ role: string } & Record<string, unknown>> = [];
      const unsubscribe = active.subscribe((event) => {
        if (event.type === "message_end") {
          added.push(structuredClone(event.message) as (typeof added)[number]);
        } else if (event.type === "compaction_end" && event.result) {
          added.push({
            role: "compactionSummary",
            summary: event.result.summary,
            tokensBefore: event.result.tokensBefore,
          });
        }
      });
      const abort = () => void active.abort();
      host.signal.addEventListener("abort", abort, { once: true });
      try {
        await active.bindExtensions({
          onError: (error) => console.warn("pi-native.extension_error", error.event, error.error),
        });
        stopIfCancelled(host.signal);
        await active.prompt(run.prompt, {
          expandPromptTemplates: false,
          images: piImages(run.images),
        });
      } finally {
        host.signal.removeEventListener("abort", abort);
        unsubscribe();
      }
      await host.decide(
        {
          type: "transcript",
          dialect: "pi-ai",
          messages: added,
          systemPrompt: active.systemPrompt,
        },
        "recorded",
      );
      const last = added.findLast((message) => message.role === "assistant");
      if (last?.stopReason === "error") {
        throw new Error(String(last.errorMessage ?? "The model call failed"));
      }
      return { type: "done", text: active.getLastAssistantText() ?? undefined };
    } finally {
      session?.dispose();
      await rm(agentDir, { recursive: true, force: true });
    }
  },
};
