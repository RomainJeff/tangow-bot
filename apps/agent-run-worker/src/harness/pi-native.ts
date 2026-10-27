import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { GuestBody, GuestImage, GuestRunInput, ReplyFinal } from "@rakazo/adapter-kit";
import { PI_NATIVE_HARNESS, RAKAZO_TOOL_PREFIX } from "@rakazo/adapter-kit";
import {
  createAgentTextPolicy,
  describeToolActivity,
  stripModelControlTokens,
} from "@rakazo/adapters/agent-text-policy";
import { guestRuntimeModel } from "@rakazo/adapters/pi-run-model";
import {
  piAiProviderStream,
  projectPiAi,
  relayedModel,
} from "@rakazo/adapters/runtime-worker/pi-ai";
import { skillReadName } from "@rakazo/adapters/volume-skills";
import type { DoneBody, GuestHarness, HarnessHost } from "../harness.js";
import { rakazoMcpTools } from "../rakazo-mcp.js";
import { durableBashTool } from "./durable-bash.js";
import { exactToolSearchExtension } from "./exact-tool-search.js";
import { relayModelRuntime } from "./pi-session.js";
import { rakazoMcpTransport } from "./rakazo-mcp.js";

type SteeringMessage = Extract<ReplyFinal, { type: "steering" }>["messages"][number];
type TranscriptMessage = Extract<GuestBody, { type: "transcript" }>["messages"][number];

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
  run: GuestRunInput,
  cwd: string,
  agent: string,
  controllerNames: ReadonlyMap<string, string>,
  steer: (message: SteeringMessage) => void,
  nudge: (text: string, mode: "steer" | "followUp") => void,
) {
  const seenIds: string[] = [];
  // The same reminders as Rakazo's own loop, worded with the name this model knows.
  const textPolicy = createAgentTextPolicy({
    ...run,
    messageUserName: `${RAKAZO_TOOL_PREFIX}message_user`,
  });
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
      await host.emit({
        type: "progress",
        text: describeToolActivity(controllerNames.get(event.toolName) ?? event.toolName),
        activity: true,
      });
    });
    pi.on("tool_result", async (event) => {
      if (event.toolName !== "read" || event.isError) return;
      const name = await skillReadName(cwd, event.input.path);
      if (name) await host.decide({ type: "skills.used", name }, "recorded");
    });
    pi.on("turn_end", async (event) => {
      if (agent !== "root") return;
      if (event.message.role === "assistant") {
        const { content } = event.message;
        const prompts = textPolicy.turn({
          messageText: stripModelControlTokens(
            content.map((block) => (block.type === "text" ? block.text : "")).join(""),
          ),
          toolCallNames: content.flatMap((block) =>
            block.type === "toolCall" ? [controllerNames.get(block.name) ?? block.name] : [],
          ),
          hasToolResults: event.toolResults.length > 0,
          paused: host.paused(),
        });
        for (const text of prompts.steer) nudge(text, "steer");
        for (const text of prompts.followUp) nudge(text, "followUp");
      }
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
 * and shell tools run here. Every model call goes through the controller's relay.
 */
export const piNativeHarness: GuestHarness = {
  declaration: PI_NATIVE_HARNESS,

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
    let reportFailed: { error: unknown } | undefined;
    let lastAssistant: { stopReason?: unknown; errorMessage?: unknown } | undefined;
    // Each message is the controller's before the loop acts on it, so a call is logged before it runs.
    const report = async (message: TranscriptMessage) => {
      if (reportFailed || host.signal.aborted) return;
      try {
        await host.decide(
          { type: "transcript", agent, dialect: "pi-ai", messages: [message] },
          "recorded",
        );
      } catch (error) {
        reportFailed = { error };
        void session?.abort();
      }
    };
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
          exactToolSearchExtension(
            (term) =>
              assignedNames.get(
                term.startsWith(RAKAZO_TOOL_PREFIX) ? term.slice(RAKAZO_TOOL_PREFIX.length) : term,
              ) ?? term,
          ),
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
                      // Pi's 60 s default would hand the model a timeout while a helper or
                      // browser_run still works; the controller's own limits bound every call.
                      timeout: 0,
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
          (pi) => {
            pi.on("message_end", async (event) => {
              const message = structuredClone(event.message);
              if (message.role === "assistant") {
                lastAssistant = message;
                for (const block of message.content) {
                  if (block.type === "toolCall")
                    block.name = controllerNames.get(block.name) ?? block.name;
                }
              } else if (message.role === "toolResult") {
                message.toolName = controllerNames.get(message.toolName) ?? message.toolName;
              } else return;
              await report(message as TranscriptMessage);
            });
            pi.on("session_compact", ({ compactionEntry }) =>
              report({
                role: "compactionSummary",
                summary: compactionEntry.summary,
                tokensBefore: compactionEntry.tokensBefore,
              }),
            );
          },
          rakazoExtension(
            host,
            run,
            cwd,
            agent,
            controllerNames,
            (message) =>
              session?.agent.steer({
                role: "user",
                content: [{ type: "text", text: message.text }, ...piImages(message.images ?? [])],
                timestamp: Date.now(),
              }),
            (text, mode) =>
              session?.agent[mode]({
                role: "user",
                content: [{ type: "text", text }],
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
          `${RAKAZO_TOOL_PREFIX}*`,
          ...(controllerTools.some((tool) => typeof tool.catalog === "object")
            ? ["tool_search"]
            : []),
        ],
      }));
      const active = session;

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
      }
      stopIfCancelled(host.signal);
      if (reportFailed) throw reportFailed.error;
      if (lastAssistant?.stopReason === "error") {
        throw new Error(String(lastAssistant.errorMessage ?? "The model call failed"));
      }
      return { type: "done", text: active.getLastAssistantText() ?? undefined };
    } finally {
      session?.dispose();
      await rm(agentDir, { recursive: true, force: true });
    }
  },
};
