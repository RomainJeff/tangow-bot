import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GuestRunInput } from "@rakazo/adapter-kit";
import { builtinAgentTools } from "@rakazo/adapters";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HarnessHost } from "../harness.js";
import { piNativeHarness } from "./pi-native.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "rakazo-pi-native-"));
  vi.stubEnv("HOME", dir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const run: GuestRunInput = {
  botId: "bot",
  threadId: "thread",
  prompt: "Reply briefly.",
  instructions: "Be brief.",
  history: [],
  images: [],
  tools: [],
  model: { provider: "openai-compatible", id: "offline-fixture" },
};

/** A host that records model requests and supports nothing else. */
function recordingHost(signal: AbortSignal) {
  const requests: unknown[] = [];
  const host: HarnessHost = {
    signal,
    paused: () => false,
    emit: async () => undefined,
    decide: async () => {
      throw new Error("No frame is decided in this test");
    },
    model: async (body) => {
      requests.push(body);
      return { type: "model.end" };
    },
    callTool: async () => {
      throw new Error("No tool runs in this test");
    },
  };
  return { host, requests };
}

function runPi(host: HarnessHost, input: Partial<Parameters<typeof piNativeHarness.run>[0]> = {}) {
  return piNativeHarness.run(
    {
      worker: { runId: "run", attemptId: "attempt", fence: 1 },
      run,
      cwd: dir,
      skillsDir: path.join(dir, "skills"),
      ...input,
    },
    host,
  );
}

it.each(
  (
    [
      ["before it starts", (cancel: AbortController) => cancel.abort()],
      ["while it sets up", (cancel: AbortController) => setImmediate(() => cancel.abort())],
    ] as const
  ).flatMap(([when, cancelRun]) =>
    ["root", "helper:1"].map((agent) => ({ when, cancelRun, agent })),
  ),
)("makes no model call when $agent is cancelled $when", async ({ cancelRun, agent }) => {
  const cancel = new AbortController();
  const { host, requests } = recordingHost(cancel.signal);
  cancelRun(cancel);

  await expect(runPi(host, { agent })).rejects.toThrow("cancelled");
  expect(requests).toEqual([]);
});

it("relays a ChatGPT subscription model, whose credential only the controller holds", async () => {
  const { host, requests } = recordingHost(new AbortController().signal);

  // The empty relayed reply fails the run afterwards; only reaching the relay matters here.
  await runPi(host, {
    run: { ...run, model: { provider: "openai-codex", id: "gpt-5.6-luna" } },
  }).catch(() => undefined);
  expect(requests).not.toEqual([]);
});

it("loads original connector names through pi's real MCP registration and wrapped tool_search", async () => {
  const long = "GITHUB_GET_A_THREAD_SUBSCRIPTION_FOR_THE_AUTHENTICATED_USER_WITH_NOTIFICATIONS";
  const hyphenated = "mail.send-message";
  const assigned = [
    "mcp__rakazo__GITHUB_GET_A_THREAD_SUBSCRIPTION_FOR_THE_A_4a24c604",
    "mcp__rakazo__mail_send_message",
  ];
  const queries = [`${long}, mcp__rakazo__${hyphenated}`, assigned.join(", ")];
  const transcripts: unknown[] = [];
  const { host } = recordingHost(new AbortController().signal);
  host.decide = (async (body, expected) => {
    if (body.type === "transcript") transcripts.push(...body.messages);
    return expected === "steering" ? { type: "steering", messages: [] } : { type: "recorded" };
  }) as HarnessHost["decide"];
  host.model = async (_body, onPart) => {
    const query = queries.shift();
    onPart({
      type: "model.event",
      event: {
        type: "done",
        reason: query ? "toolUse" : "stop",
        message: {
          role: "assistant",
          content: query
            ? [
                {
                  type: "toolCall",
                  id: `search-${queries.length}`,
                  name: "tool_search",
                  arguments: { query, limit: 1 },
                },
              ]
            : [{ type: "text", text: "Done." }],
          api: "openai-completions",
          provider: "openai-compatible",
          model: "offline-fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: query ? "toolUse" : "stop",
          timestamp: 0,
        },
      },
    });
    return { type: "model.end" };
  };

  await runPi(host, {
    run: {
      ...run,
      tools: [long, hyphenated].map((name) => ({
        name,
        description: "Read connected app data.",
        inputSchema: { type: "object", properties: {} },
        where: "controller",
        catalog: { via: "mcp_execute_tool", id: name },
      })),
    },
  });

  expect(transcripts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "toolResult",
        toolName: "tool_search",
        details: { loaded: assigned },
        isError: false,
      }),
      expect.objectContaining({
        role: "toolResult",
        toolName: "tool_search",
        details: { loaded: [] },
        isError: false,
        content: [{ type: "text", text: "The requested tools are already available." }],
      }),
    ]),
  );
});

it.each([
  { title: "Offline widget view", html: "<p>View</p>" },
  { title: "Offline widget view", path: "/tmp/view.html" },
])("passes widget content through real MCP argument validation: %j", async (args) => {
  const tool = builtinAgentTools.find((candidate) => candidate.name === "show_widget");
  if (!tool) throw new Error("show_widget is missing");
  const { host } = recordingHost(new AbortController().signal);
  host.decide = (async (_body, expected) =>
    expected === "steering"
      ? { type: "steering", messages: [] }
      : { type: "recorded" }) as HarnessHost["decide"];
  host.callTool = vi.fn(async () => ({ ok: true }));
  let calls = 0;
  host.model = async (_body, onPart) => {
    const call = calls++ === 0;
    onPart({
      type: "model.event",
      event: {
        type: "done",
        reason: call ? "toolUse" : "stop",
        message: {
          role: "assistant",
          content: call
            ? [
                {
                  type: "toolCall",
                  id: "widget-1",
                  name: "mcp__rakazo__show_widget",
                  arguments: args,
                },
              ]
            : [{ type: "text", text: "Done." }],
          api: "openai-completions",
          provider: "openai-compatible",
          model: "offline-fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: call ? "toolUse" : "stop",
          timestamp: 0,
        },
      },
    });
    return { type: "model.end" };
  };

  await runPi(host, {
    run: {
      ...run,
      tools: [
        {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          where: "controller",
        },
      ],
    },
  });

  expect(host.callTool).toHaveBeenCalledWith("root", "show_widget", args, expect.any(String));
});

it("returns a controller tool result that arrives after pi's 60 s request default", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const transcripts: { role?: string; toolName?: string; isError?: boolean }[] = [];
    const { host } = recordingHost(new AbortController().signal);
    host.decide = (async (body, expected) => {
      if (body.type === "transcript") transcripts.push(...(body.messages as never[]));
      return expected === "steering" ? { type: "steering", messages: [] } : { type: "recorded" };
    }) as HarnessHost["decide"];
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    host.callTool = () => {
      markStarted();
      return new Promise((resolve) => setTimeout(() => resolve("slow done"), 61_000));
    };
    let calls = 0;
    host.model = async (_body, onPart) => {
      const call = calls++ === 0;
      onPart({
        type: "model.event",
        event: {
          type: "done",
          reason: call ? "toolUse" : "stop",
          message: {
            role: "assistant",
            content: call
              ? [{ type: "toolCall", id: "slow-1", name: "mcp__rakazo__slow", arguments: {} }]
              : [{ type: "text", text: "Done." }],
            api: "openai-completions",
            provider: "openai-compatible",
            model: "offline-fixture",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: call ? "toolUse" : "stop",
            timestamp: 0,
          },
        },
      });
      return { type: "model.end" };
    };

    const done = runPi(host, {
      run: {
        ...run,
        tools: [
          {
            name: "slow",
            description: "A long controller tool.",
            inputSchema: { type: "object", properties: {} },
            where: "controller",
          },
        ],
      },
    });
    await started;
    await vi.advanceTimersByTimeAsync(70_000);
    await done;

    expect(transcripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "toolResult", toolName: "slow", isError: false }),
      ]),
    );
  } finally {
    vi.useRealTimers();
  }
});
