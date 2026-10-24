import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { GuestImage, ReplyFinal } from "@rakazo/adapter-kit";
import { PI_NATIVE_HARNESS } from "@rakazo/adapter-kit";
import { guestRuntimeModel } from "@rakazo/adapters/pi-runtime";
import {
  piAiProviderStream,
  projectPiAi,
  relayedModel,
} from "@rakazo/adapters/runtime-worker/pi-ai";
import { skillReadName } from "@rakazo/adapters/volume-skills";
import type { DoneBody, GuestHarness, HarnessHost } from "../harness.js";
import { rakazoMcpTools } from "../rakazo-mcp.js";
import { durableBashTool } from "./durable-bash.js";
import { relayModelRuntime } from "./pi-session.js";
import { piToolManifest } from "./pi-tools.js";
import { rakazoMcpTransport } from "./rakazo-mcp.js";

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
  agent: string,
  steer: (message: SteeringMessage) => void,
) {
  const seenIds: string[] = [];
  return (pi: ExtensionAPI) => {
    pi.on("message_update", async (event) => {
      if (event.assistantMessageEvent.type === "text_delta") {
        const text = event.assistantMessageEvent.delta;
        if (agent === "root") await host.emit({ type: "text", text });
        else await host.decide({ type: "subagent.text", agent, text }, "recorded");
      }
    });
    pi.on("tool_execution_start", async (event) => {
      if (agent !== "root") return;
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
      if (agent !== "root" || event.toolResults.length === 0) return;
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
  declaration: PI_NATIVE_HARNESS,
  nativeTools: piToolManifest(),
  async executeNativeTool() {
    throw new Error("pi-native runs its own tools");
  },

  async run({ run, cwd, skillsDir, outputRoot, agent = "root" }, host): Promise<DoneBody> {
    stopIfCancelled(host.signal);
    const model = guestRuntimeModel(relayedModel(run.model));
    const modelRuntime = await relayModelRuntime(
      model,
      piAiProviderStream((body, onPart, signal) => host.model({ ...body, agent }, onPart, signal)),
    );
    // Pi's config home for this attempt only: nothing from the image or an earlier run loads.
    const agentDir = await mkdtemp(path.join(tmpdir(), "rakazo-pi-"));
    // One untrusted, in-memory settings store: no settings file is read, the volume's least of all.
    const settingsManager = SettingsManager.inMemory(PI_SETTINGS, {
      projectTrusted: false,
    });
    let session: AgentSession | undefined;
    try {
      const controllerTools = run.tools.filter((tool) => tool.where === "controller");
      const assignedNames = new Map<string, string>();
      const controllerNames = new Map<string, string>();
      const listed = rakazoMcpTools(controllerTools, true);
      const byLabel = new Map(listed.map((tool) => [`rakazo/${tool.name}`, tool]));
      const projected = projectPiAi(run.history, run.prompt, model, run.sourceMessageId);
      const replayCalls = new Set(
        projected.flatMap((message) =>
          message.role === "assistant"
            ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
            : [],
        ),
      );
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noSkills: true,
        additionalSkillPaths: [skillsDir],
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          createToolSearchExtension(),
          (pi) =>
            createMcpExtension({
              loadConfig: () => ({
                servers: [
                  {
                    name: "rakazo",
                    source: "rakazo",
                    scope: "extension",
                    config: {
                      command: "rakazo-in-process",
                      exposure: "direct",
                      toolExposure: Object.fromEntries(
                        listed.map((tool) => [tool.name, tool.exposure]),
                      ),
                    },
                  },
                ],
                errors: [],
                autoEnableCodemode: false,
              }),
              createTransport: () =>
                rakazoMcpTransport(
                  controllerTools,
                  {
                    ...host,
                    callTool: (_agent, name, args, callId) =>
                      host.callTool(agent, name, args, callId),
                  },
                  cwd,
                ),
            })({
              ...pi,
              registerTool(definition) {
                // Pi assigns names before registration; the label retains the MCP server/tool identity.
                const tool = byLabel.get(definition.label);
                if (tool) {
                  assignedNames.set(tool.name, definition.name);
                  controllerNames.set(definition.name, tool.catalog?.via ?? tool.name);
                }
                pi.registerTool(definition);
              },
            }),
          (pi) => {
            pi.on("context", (event) => {
              const messages = structuredClone(event.messages);
              const resultNames = new Map<string, string>();
              for (const message of messages) {
                if (message.role === "assistant") {
                  for (const block of message.content) {
                    if (block.type !== "toolCall" || !replayCalls.has(block.id)) continue;
                    const catalog = listed.find(
                      (tool) =>
                        tool.catalog?.via === block.name && tool.catalog.id === block.arguments.id,
                    );
                    const assigned = assignedNames.get(catalog?.name ?? block.name);
                    if (!assigned) continue;
                    block.name = assigned;
                    if (
                      catalog &&
                      typeof block.arguments.arguments === "object" &&
                      block.arguments.arguments !== null &&
                      !Array.isArray(block.arguments.arguments)
                    ) {
                      block.arguments = Object.fromEntries(
                        Object.entries(block.arguments.arguments),
                      );
                    }
                    resultNames.set(block.id, assigned);
                  }
                } else if (message.role === "toolResult") {
                  message.toolName = resultNames.get(message.toolCallId) ?? message.toolName;
                }
              }
              return { messages };
            });
          },
          rakazoExtension(host, cwd, agent, (message) =>
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
      for (const message of projected) {
        sessionManager.appendMessage(message);
      }

      ({ session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        model,
        thinkingLevel: run.model.thinkingLevel ?? undefined,
        resourceLoader: loader,
        customTools: [defineTool(durableBashTool(cwd, outputRoot ?? agentDir))],
        sessionManager,
        settingsManager,
        tools: [
          ...run.tools.filter((tool) => tool.where === "guest").map((tool) => tool.name),
          "mcp__rakazo__*",
          ...(controllerTools.some((tool) => typeof tool.catalog === "object")
            ? ["tool_search"]
            : []),
        ],
      }));
      const active = session;

      // What the attempt adds, in order: the controller ingests it into canonical history.
      const added: Array<{ role: string } & Record<string, unknown>> = [];
      const unsubscribe = active.subscribe((event) => {
        if (event.type === "message_end") {
          const message = structuredClone(event.message);
          if (message.role === "assistant") {
            for (const block of message.content) {
              if (block.type === "toolCall")
                block.name = controllerNames.get(block.name) ?? block.name;
            }
          } else if (message.role === "toolResult") {
            message.toolName = controllerNames.get(message.toolName) ?? message.toolName;
          }
          added.push(message as (typeof added)[number]);
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
        if (!host.signal.aborted || added.length > 0)
          await host.decide(
            {
              type: "transcript",
              agent,
              dialect: "pi-ai",
              messages: added,
              systemPrompt: active.systemPrompt,
            },
            "recorded",
          );
      }
      stopIfCancelled(host.signal);
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
