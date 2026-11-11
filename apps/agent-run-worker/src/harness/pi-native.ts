import { AsyncLocalStorage } from "node:async_hooks";
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
import type { GuestBody, GuestImage, GuestRunInput, ReplyFinal } from "@tangow/adapter-kit";
import { PI_NATIVE_HARNESS, TANGOW_TOOL_PREFIX } from "@tangow/adapter-kit";
import {
  createAgentTextPolicy,
  describeToolActivity,
  stripModelControlTokens,
} from "@tangow/adapters/agent-text-policy";
import { guestRuntimeModel } from "@tangow/adapters/pi-run-model";
import {
  piAiProviderStream,
  projectPiAi,
  relayedModel,
} from "@tangow/adapters/runtime-worker/pi-ai";
import { skillReadName } from "@tangow/adapters/volume-skills";
import type { DoneBody, GuestHarness, HarnessHost } from "../harness.js";
import { mcpResult, rakazoMcpTools } from "../tangow-mcp.js";
import { durableBashTool } from "./durable-bash.js";
import { exactToolSearchExtension } from "./exact-tool-search.js";
import { relayModelRuntime } from "./pi-session.js";
import { callOccurrenceId, capturePiSnapshot, restorePiSnapshot } from "./pi-snapshot.js";
import { rakazoMcpTransport } from "./tangow-mcp.js";

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

/** Tangow's hooks into Pi's own loop. Pi awaits each one, so the channel paces the loop. */
function rakazoExtension(
  host: HarnessHost,
  run: GuestRunInput,
  cwd: string,
  agent: string,
  controllerNames: ReadonlyMap<string, string>,
  seenIds: string[],
  steer: (message: SteeringMessage) => void,
  nudge: (text: string, mode: "steer" | "followUp") => void,
) {
  // The same reminders as Tangow's own loop, worded with the name this model knows.
  const textPolicy = createAgentTextPolicy({
    ...run,
    messageUserName: `${TANGOW_TOOL_PREFIX}message_user`,
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
      if (agent !== "root" || host.paused()) return;
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
    const start = run.start;
    const durable = agent === "root" && start !== undefined;
    const restored = start?.mode === "resume" ? restorePiSnapshot(start.snapshot, cwd) : undefined;
    const sessionManager = restored?.manager ?? SessionManager.inMemory(cwd);
    const seenIds = restored?.steeringIds ?? [];
    const deliveredEvents = start?.mode === "resume" ? [...start.snapshot.deliveredEvents] : [];
    const nativeCall = new AsyncLocalStorage<string>();
    const model = guestRuntimeModel(relayedModel(run.model));
    const modelRuntime = await relayModelRuntime(
      model,
      piAiProviderStream(async (body, onPart, signal) => {
        return host.model({ ...body, agent }, onPart, signal);
      }),
    );
    // Pi's config home for this attempt only: nothing from the image or an earlier run loads.
    const agentDir = await mkdtemp(path.join(tmpdir(), "rakazo-pi-"));
    // One untrusted, in-memory settings store: no settings file is read, the volume's least of all.
    const settingsManager = SettingsManager.inMemory(PI_SETTINGS, {
      projectTrusted: false,
    });
    let revision = start?.mode === "resume" ? start.snapshot.revision : 0;
    let session: AgentSession | undefined;
    let checkpoint:
      | {
          leaf: string | null;
          steeringIds: string[];
          deliveredEvents: string[];
        }
      | undefined;
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
      const projected = restored
        ? []
        : projectPiAi(run.history, run.prompt, model, run.sourceMessageId);
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
                term.startsWith(TANGOW_TOOL_PREFIX) ? term.slice(TANGOW_TOOL_PREFIX.length) : term,
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
                      // The controller bounds every call (budgets, stop, cancel); pi's 60 s default would drop the result of a long one.
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
                  () => nativeCall.getStore(),
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
                pi.registerTool({
                  ...definition,
                  ...(restored?.activeTools.includes(definition.name)
                    ? { exposure: "direct" as const }
                    : {}),
                  execute: (callId, ...args) => {
                    const message = sessionManager
                      .getBranch()
                      .findLast(
                        (entry) => entry.type === "message" && entry.message.role === "assistant",
                      );
                    if (!message) throw new Error("A controller call requires its native message");
                    return nativeCall.run(callOccurrenceId(message.id, callId), () =>
                      definition.execute(callId, ...args),
                    );
                  },
                });
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
            pi.on("tool_call", () => {
              if (!durable || host.paused()) return;
              checkpoint = {
                leaf: sessionManager.getLeafId(),
                steeringIds: [...seenIds],
                deliveredEvents: [...deliveredEvents],
              };
            });
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
            seenIds,
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
          `${TANGOW_TOOL_PREFIX}*`,
          ...(controllerTools.some((tool) => typeof tool.catalog === "object")
            ? ["tool_search"]
            : []),
        ],
      }));
      const active = session;
      const finishTurn = active.agent.finishTurn;
      active.agent.finishTurn = async (turn, signal) => {
        const decision = await finishTurn?.(turn, signal);
        if (!durable || !host.paused()) return decision ?? undefined;
        active.setAutoCompactionEnabled(false);
        return { action: "end" };
      };

      const abort = () => void active.abort();
      host.signal.addEventListener("abort", abort, { once: true });
      try {
        await active.bindExtensions({
          onError: (error) => console.warn("pi-native.extension_error", error.event, error.error),
        });
        stopIfCancelled(host.signal);
        if (restored) {
          const allowedNative = new Set(
            run.tools.filter((tool) => tool.where === "guest").map((tool) => tool.name),
          );
          const available = new Set(
            active
              .getAllTools()
              .map((tool) => tool.name)
              .filter(
                (name) =>
                  allowedNative.has(name) ||
                  controllerNames.has(name) ||
                  (name === "tool_search" &&
                    controllerTools.some((tool) => typeof tool.catalog === "object")),
              ),
          );
          active.setActiveToolsByName(restored.activeTools.filter((name) => available.has(name)));
          const callIds = new Set(
            sessionManager
              .getBranch()
              .flatMap((entry) =>
                entry.type === "message" && entry.message.role === "assistant"
                  ? entry.message.content.flatMap((block) =>
                      block.type === "toolCall" ? [callOccurrenceId(entry.id, block.id)] : [],
                    )
                  : [],
              ),
          );
          const pending = new Map<string, { id: string; name: string }>();
          const openByProviderId = new Map<string, string>();
          for (const entry of sessionManager.buildSessionProjection().entries) {
            for (const message of entry.messages) {
              if (message.role === "assistant") {
                for (const block of message.content) {
                  if (block.type !== "toolCall") continue;
                  const id = callOccurrenceId(entry.sourceEntry.id, block.id);
                  pending.set(id, block);
                  openByProviderId.set(block.id, id);
                }
              } else if (message.role === "toolResult") {
                const id = openByProviderId.get(message.toolCallId);
                if (id) pending.delete(id);
                openByProviderId.delete(message.toolCallId);
              }
            }
          }
          if (
            start?.mode === "resume" &&
            start.receipts.some(
              (receipt) => receipt.outcome.kind === "paused" && !pending.has(receipt.callId),
            )
          )
            throw new Error("Paused receipt is missing its native call");
          const { receipts } = await host.decide({ type: "snapshot.resolve" }, "snapshot.receipts");
          for (const [callId, block] of pending) {
            const receipt = receipts.find((item) => item.callId === callId);
            const result =
              receipt?.outcome.kind === "result"
                ? await mcpResult(receipt.outcome.output, cwd)
                : {
                    content: [
                      {
                        type: "text" as const,
                        text:
                          receipt || !block.name.startsWith(TANGOW_TOOL_PREFIX)
                            ? "The interrupted call has an unknown outcome. It was not replayed."
                            : "This call was not started before interruption. It was not replayed.",
                      },
                    ],
                    isError: true,
                  };
            sessionManager.appendMessage({
              role: "toolResult",
              toolCallId: block.id,
              toolName: block.name,
              content: result.content.flatMap<
                { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
              >((item) =>
                item.type === "text" && typeof item.text === "string"
                  ? [{ type: "text" as const, text: item.text }]
                  : item.type === "image" &&
                      typeof item.data === "string" &&
                      typeof item.mimeType === "string"
                    ? [{ type: "image" as const, data: item.data, mimeType: item.mimeType }]
                    : [],
              ),
              isError:
                result.isError || (receipt?.outcome.kind === "result" && receipt.outcome.isError),
              timestamp: Date.now(),
            });
          }
          active.agent.state.messages = sessionManager.buildSessionContext().messages;
          for (const receipt of receipts) {
            const alreadyDelivered = sessionManager
              .getEntries()
              .some(
                (entry) =>
                  entry.type === "custom_message" &&
                  entry.customType === "rakazo.controller-result" &&
                  entry.details &&
                  typeof entry.details === "object" &&
                  "callId" in entry.details &&
                  entry.details.callId === receipt.callId,
              );
            if (
              alreadyDelivered ||
              callIds.has(receipt.callId) ||
              receipt.outcome.kind !== "result"
            )
              continue;
            await active.sendCustomMessage({
              customType: "rakazo.controller-result",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ tool: receipt.name, outcome: receipt.outcome }),
                },
              ],
              display: false,
              details: { callId: receipt.callId },
            });
          }
          for (const event of run.resumeEvents ?? []) {
            if (deliveredEvents.includes(event.id)) continue;
            await active.sendCustomMessage({
              customType: "rakazo.event",
              content: event.text,
              display: false,
              details: { eventId: event.id },
            });
            deliveredEvents.push(event.id);
          }
          const steering = await host.decide(
            { type: "steering.claim", seenIds: [...seenIds] },
            "steering",
          );
          for (const message of steering.messages) {
            seenIds.push(message.id);
            await active.sendCustomMessage({
              customType: "rakazo.steering",
              content: [{ type: "text", text: message.text }, ...piImages(message.images ?? [])],
              display: false,
              details: { steeringId: message.id },
            });
          }
          await active.sendCustomMessage(
            {
              customType: "rakazo.resume",
              content: [
                {
                  type: "text",
                  text:
                    run.resumeEvent && run.resumeEvent !== restored.input
                      ? run.resumeEvent
                      : "The same run resumed after interruption. Controller call outcomes have been reconciled.",
                },
              ],
              display: false,
              details: { resumed: true },
            },
            { triggerTurn: true },
          );
        } else {
          await active.prompt(run.prompt, {
            expandPromptTemplates: false,
            images: piImages(run.images),
          });
        }
      } finally {
        host.signal.removeEventListener("abort", abort);
      }
      stopIfCancelled(host.signal);
      if (durable && host.paused()) {
        if (!checkpoint) throw new Error("The paused agent has no resume point");
        await host.decide(
          {
            type: "snapshot.save",
            snapshot: capturePiSnapshot(
              sessionManager,
              active.getActiveToolNames(),
              ++revision,
              checkpoint.steeringIds,
              run.resumeEvent ?? run.prompt,
              checkpoint.deliveredEvents,
              checkpoint.leaf,
              new Set([
                ...run.tools.filter((tool) => tool.where === "guest").map((tool) => tool.name),
                "tool_search",
              ]),
            ),
          },
          "recorded",
        );
      }
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
