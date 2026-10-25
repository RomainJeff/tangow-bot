import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { toHistory } from "./pi-runtime.js";
import type { WireProtocol, WireUsage } from "./pi-sdk-proof-support.js";
import {
  chainDurableSteering,
  createProofSession,
  proofModelRuntime,
} from "./pi-sdk-proof-support.js";
import {
  calls,
  deferred,
  done,
  fixture,
  KEY,
  lines,
  PROTOCOLS,
  persisted,
  session,
  steeringStore,
  text,
  tool,
  track,
  usePoisonedWorkspace,
  workspace,
} from "./pi-sdk-test-support.js";

const HISTORY_PAST_KEPT_RECENT_TOKENS = "old ".repeat(30_000);
const USAGE_PAST_COMPACTION_THRESHOLD: WireUsage = {
  input: 127_000,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
};
const EMPTY_SCHEMA: Record<WireProtocol, unknown> = {
  "openai-completions": { type: "object", properties: {} },
  "anthropic-messages": { type: "object", properties: {}, required: [] },
};

async function snapshot(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(dir, path)] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }
  return files;
}

usePoisonedWorkspace();

describe.each(PROTOCOLS)("Pi SDK session over %s", (protocol) => {
  it("sends only the injected prompt, history, tools and key, and writes nothing", async () => {
    const before = { home: await snapshot(workspace.home), cwd: await snapshot(workspace.cwd) };
    const wire = await fixture(protocol, [
      () => ({
        type: "message",
        blocks: [{ type: "text", text: "done" }],
        usage: USAGE_PAST_COMPACTION_THRESHOLD,
      }),
    ]);
    const runtime = await proofModelRuntime(wire, KEY);
    const history = toHistory(
      [
        { role: "assistant", content: "Summary of earlier work." },
        { id: "m0", role: "user", content: HISTORY_PAST_KEPT_RECENT_TOKENS },
        { id: "m1", role: "user", content: "/skill:poison earlier question" },
        {
          id: "m2",
          role: "assistant",
          content: "",
          parts: [
            { type: "text", text: "Checking." },
            {
              type: "toolCalls",
              calls: [{ id: "h1", name: "lookup", args: { q: "x" }, output: "found x" }],
            },
            { type: "text", text: "It is x." },
          ],
        },
      ],
      "current question",
      runtime.model,
    );
    const systemPrompt = join(workspace.cwd, "AGENTS.md");
    const created = await createProofSession({
      cwd: workspace.cwd,
      agentDir: workspace.agentDir,
      runtime,
      systemPrompt,
      transcript: { kind: "history", messages: history },
      tools: [tool("lookup", async () => done("unused"))],
    });
    track(created);
    await created.prompt("/skill:poison current question", { expandPromptTemplates: false });

    wire.assertComplete();
    expect(wire.requests).toEqual([
      {
        credential: KEY,
        tools: ["lookup"],
        schemas: { lookup: EMPTY_SCHEMA[protocol] },
        transcript: [
          `system: ${systemPrompt}\n\n<cwd>\n${workspace.cwd}\n</cwd>`,
          "user: <assistant_turn>\nSummary of earlier work.\n</assistant_turn>",
          `user: ${HISTORY_PAST_KEPT_RECENT_TOKENS}`,
          "user: /skill:poison earlier question",
          "assistant: Checking.",
          'call h1 lookup {"q":"x"}',
          "tool h1: found x",
          "assistant: It is x.",
          "user: /skill:poison current question",
        ],
      },
    ]);
    expect(created.sessionFile).toBeUndefined();
    expect({ home: await snapshot(workspace.home), cwd: await snapshot(workspace.cwd) }).toEqual(
      before,
    );
    expect(await readdir(workspace.agentDir)).toEqual([]);
  });

  it("restores a compacted session as summary plus kept messages without replaying old effects", async () => {
    const wire = await fixture(protocol, [text("done")]);
    const runtime = await proofModelRuntime(wire, KEY);
    const effects: string[] = [];
    const original = SessionManager.inMemory(workspace.cwd);
    const append = (message: AgentMessage) => {
      if (
        message.role !== "user" &&
        message.role !== "assistant" &&
        message.role !== "toolResult"
      ) {
        throw new Error(`Unexpected ${message.role} message`);
      }
      return original.appendMessage(message);
    };
    const [oldPrompt, ...oldTurn] = toHistory(
      [
        { id: "m1", role: "user", content: "old question" },
        {
          id: "m2",
          role: "assistant",
          content: "",
          parts: [
            {
              type: "toolCalls",
              calls: [{ id: "old-1", name: "lookup", args: { q: "old" }, output: "old effect" }],
            },
            { type: "text", text: "old answer" },
          ],
        },
        { id: "m3", role: "user", content: "kept question" },
        { id: "m4", role: "assistant", content: "kept answer" },
      ],
      "new question",
      runtime.model,
    );
    const kept = oldTurn.splice(-2);
    for (const message of [oldPrompt, ...oldTurn]) if (message) append(message);
    const keptIds = kept.map(append);
    original.appendCompaction("Earlier: looked up old.", keptIds[0] ?? null, 1_234);

    const restoredManager = SessionManager.inMemory(workspace.cwd, undefined, [
      original.getHeader()!,
      ...original.getEntries(),
    ]);
    const restored = await createProofSession({
      cwd: workspace.cwd,
      agentDir: workspace.agentDir,
      runtime,
      systemPrompt: "Fixture system.",
      transcript: { kind: "restore", manager: restoredManager },
      tools: [
        tool("lookup", async () => {
          effects.push("lookup");
          return done("replayed");
        }),
      ],
    });
    track(restored);
    await restored.prompt("new question", { expandPromptTemplates: false });

    wire.assertComplete();
    expect(effects).toEqual([]);
    expect(wire.requests[0]?.transcript).toEqual([
      `system: Fixture system.\n\n<cwd>\n${workspace.cwd}\n</cwd>`,
      "user: The conversation history before this point was compacted into the following summary:\n\n<summary>\nEarlier: looked up old.\n</summary>",
      "user: kept question",
      "assistant: kept answer",
      "user: new question",
    ]);
    expect(
      restoredManager
        .getEntries()
        .flatMap((entry) =>
          entry.type === "message"
            ? lines(entry.message)
            : entry.type === "compaction"
              ? [`compaction: ${entry.summary}`]
              : [],
        ),
    ).toEqual([
      "user: old question",
      'call old-1 lookup {"q":"old"}',
      "tool old-1: old effect",
      "assistant: old answer",
      "user: kept question",
      "assistant: kept answer",
      "compaction: Earlier: looked up old.",
      "user: new question",
      "assistant: done",
    ]);
  });

  it("delivers durable steering once at the next safe point while a helper and a slow tool run", async () => {
    const store = steeringStore();
    store.add("/skill:poison before start");
    const helperAsked = deferred();
    const wire = await fixture(protocol, [
      calls("slow", "helper"),
      (request) => {
        helperAsked.resolve();
        expect(request.transcript).toEqual([
          `system: Helper system.\n\n<cwd>\n${workspace.cwd}\n</cwd>`,
          "user: helper task",
        ]);
        return text("helper result")(request);
      },
      text("final"),
    ]);
    const runtime = await proofModelRuntime(wire, KEY);
    let parent: AgentSession | undefined;
    const slow = tool("slow", async () => {
      await helperAsked.promise;
      store.add("/skill:poison first");
      store.add("second");
      parent?.setActiveToolsByName(["slow", "helper"]);
      parent?.agent.steer({ role: "user", content: "native", timestamp: Date.now() });
      return done("slow done");
    });
    const helper = tool("helper", async (_id, _params, signal) => {
      const child = await createProofSession({
        cwd: workspace.cwd,
        agentDir: workspace.agentDir,
        runtime,
        systemPrompt: "Helper system.",
      });
      const stop = () => void child.abort();
      signal?.addEventListener("abort", stop);
      try {
        await child.prompt("helper task", { expandPromptTemplates: false });
        return done(child.getLastAssistantText() ?? "");
      } finally {
        signal?.removeEventListener("abort", stop);
        child.dispose();
      }
    });
    parent = await createProofSession({
      cwd: workspace.cwd,
      agentDir: workspace.agentDir,
      runtime,
      systemPrompt: "Fixture system.",
      tools: [slow, helper, tool("lookup", async () => done("unused"))],
    });
    track(parent);
    const initial = await store.claim([]);
    chainDurableSteering(
      parent,
      (seenIds) => store.claim(seenIds),
      initial.map((item) => item.id),
    );
    await parent.prompt(`go\n\n${initial.map((item) => item.text).join("\n")}`, {
      expandPromptTemplates: false,
    });

    wire.assertComplete();
    const turn = [
      "user: go\n\n/skill:poison before start",
      "call call-slow slow {}",
      "call call-helper helper {}",
      "tool call-slow: slow done",
      "tool call-helper: helper result",
      "user: /skill:poison first",
      "user: second",
      "user: native",
    ];
    expect(wire.requests[2]?.transcript).toEqual([
      `system: Fixture system.\n\n<cwd>\n${workspace.cwd}\n</cwd>`,
      ...turn,
    ]);
    expect(wire.requests.map((request) => request.tools)).toEqual([
      ["slow", "helper", "lookup"],
      [],
      ["slow", "helper"],
    ]);
    expect(store.claims).toEqual([[], ["s1"]]);
    expect(persisted(parent)).toEqual([...turn, "assistant: final"]);

    const restoredManager = SessionManager.inMemory(workspace.cwd, undefined, [
      parent.sessionManager.getHeader()!,
      ...parent.sessionManager.getEntries(),
    ]);
    const next = await fixture(protocol, [text("again")]);
    const restored = await session(next, {
      systemPrompt: "Fixture system.",
      transcript: { kind: "restore", manager: restoredManager },
      tools: [slow, helper],
    });
    await restored.prompt("follow up", { expandPromptTemplates: false });
    expect(next.requests[0]?.transcript).toEqual([
      `system: Fixture system.\n\n<cwd>\n${workspace.cwd}\n</cwd>`,
      ...turn,
      "assistant: final",
      "user: follow up",
    ]);
  });

  it("reports streamed text, thinking, tool ids and cache usage", async () => {
    const wire = await fixture(protocol, [
      () => ({
        type: "message",
        blocks: [
          { type: "thinking", text: "think" },
          { type: "text", text: "look" },
          { type: "tool", id: "call-1", name: "lookup", arguments: { q: "x" } },
        ],
        usage: { input: 11, output: 7, cacheRead: 5, cacheWrite: 3 },
      }),
      () => ({
        type: "message",
        blocks: [{ type: "text", text: "answer" }],
        usage: { input: 13, output: 2, cacheRead: 17, cacheWrite: 0 },
      }),
    ]);
    const created = await session(wire, {
      systemPrompt: "Fixture system.",
      tools: [tool("lookup", async () => done("found"))],
    });
    const seen: unknown[] = [];
    created.agent.subscribe(async (event) => {
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta" || update.type === "thinking_delta") {
          seen.push([update.type, update.delta]);
        }
      }
      if (event.type === "tool_execution_start") {
        seen.push(["toolStart", event.toolCallId, event.toolName, event.args]);
      }
      if (event.type === "tool_execution_end") {
        seen.push(["toolEnd", event.toolCallId, event.isError]);
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        const { input, output, cacheRead, cacheWrite } = event.message.usage;
        seen.push(["usage", { input, output, cacheRead, cacheWrite }, event.message.stopReason]);
      }
      if (event.type === "agent_end") seen.push(["end"]);
    });
    await created.prompt("go", { expandPromptTemplates: false });

    wire.assertComplete();
    expect(seen).toEqual([
      ["thinking_delta", "think"],
      ["text_delta", "look"],
      ["usage", { input: 11, output: 7, cacheRead: 5, cacheWrite: 3 }, "toolUse"],
      ["toolStart", "call-1", "lookup", { q: "x" }],
      ["toolEnd", "call-1", false],
      ["text_delta", "answer"],
      ["usage", { input: 13, output: 2, cacheRead: 17, cacheWrite: 0 }, "stop"],
      ["end"],
    ]);
  });
});
