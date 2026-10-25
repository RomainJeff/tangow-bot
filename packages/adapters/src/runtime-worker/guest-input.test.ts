import type { AgentRunRequest, ConnectorTool, WorkerStartV1 } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { catalogEntries, lazyCatalogTools } from "../lazy-tool-catalog.js";
import { encodeMessage } from "./framing.js";
import { helperRunInput, workerStart } from "./guest-input.js";
import { WORKER_LIMITS } from "./limits.js";

const MiB = 1024 * 1024;
const ENVELOPE: Omit<WorkerStartV1, "run"> = {
  version: 2,
  kind: "worker.start",
  worker: { runId: "r".repeat(256), attemptId: "a".repeat(256), fence: 1 },
  workspace: {
    cwd: "/workspace/bots/bot-1",
    mounts: [
      { path: "/workspace/bots/bot-1", scope: "private", access: "rw" },
      { path: "/workspace/shared", scope: "shared", access: "rw" },
    ],
  },
  computer: "on_use",
};

/** A lazy catalog of `count` tools whose descriptions are `size` bytes each. */
function catalog(name: string, count: number, size: number) {
  return lazyCatalogTools(
    name,
    name,
    name,
    catalogEntries(
      Array.from(
        { length: count },
        (_, index): ConnectorTool => ({
          name: `${name}__tool_${index}`,
          description: "d".repeat(size),
          inputSchema: { type: "object", properties: {} },
          route: { connectorId: name, resourceId: `srv-${name}`, toolName: `tool_${index}` },
        }),
      ),
    ),
  );
}

function start(prompt: string, tools: ConnectorTool[]) {
  const message = workerStart(
    ENVELOPE,
    {
      botId: "bot-1",
      threadId: "thread-1",
      prompt,
      instructions: "",
      history: [],
      tools,
      model: { provider: "test", id: "model" },
    } as unknown as AgentRunRequest,
    { name: "pi-native", capabilities: [] },
  );
  const sent = (marked: unknown) =>
    message.run.tools.filter((tool) => tool.catalog === marked).map((tool) => tool.name);
  return {
    entries: message.run.tools.filter((tool) => typeof tool.catalog === "object").length,
    fallback: sent("fallback"),
    unmarked: sent(undefined),
    bytes: encodeMessage(message).byteLength,
  };
}

/** 30 tools of about 60 KiB each: a catalog of about 1.8 MiB. */
const LARGE = catalog("mcp", 30, 60 * 1024);

describe("a large catalog in worker.start", () => {
  it("is sent with its fallback marked when it fits the start frame", () => {
    expect(start("Hello.", LARGE)).toEqual({
      entries: 30,
      fallback: ["mcp_search_tools", "mcp_load_tool", "mcp_execute_tool"],
      unmarked: [],
      bytes: expect.any(Number),
    });
  });

  it("stays behind its fallback when the prompt leaves no room, and the frame keeps its cap", () => {
    const held = start("p".repeat(6.5 * MiB), LARGE);
    expect(held.entries).toBe(0);
    expect(held.unmarked).toEqual(["mcp_search_tools", "mcp_load_tool", "mcp_execute_tool"]);
    expect(held.bytes).toBeLessThanOrEqual(WORKER_LIMITS.controllerFrameBytes);

    const sent = start("p".repeat(5 * MiB), LARGE);
    expect(sent.entries).toBe(30);
    expect(sent.bytes).toBeLessThanOrEqual(WORKER_LIMITS.controllerFrameBytes);
  });

  it("counts the fallback marks of many small catalogs against the frame", () => {
    const many = Array.from({ length: 1000 }, (_, index) => catalog(`c${index}`, 1, 10)).flat();
    const withoutCatalogs = start("p".repeat(8 * MiB), many).bytes - 8 * MiB;
    const room = 40 * 1024;
    const prompt = "p".repeat(WORKER_LIMITS.controllerFrameBytes - withoutCatalogs - room);

    const sent = start(prompt, many);

    expect(sent.bytes).toBeLessThanOrEqual(WORKER_LIMITS.controllerFrameBytes);
    expect(sent.entries).toBeGreaterThan(100);
    expect(sent.fallback).toHaveLength(sent.entries * 3);
    expect(sent.unmarked).toHaveLength((1000 - sent.entries) * 3);
  });
});

it("gives helpers the connector name index while replacing the parent's instructions", () => {
  const tools = catalog("mcp", 30, 20);
  const run = helperRunInput(
    ENVELOPE,
    {
      botId: "bot-1",
      threadId: "thread-1",
      prompt: "Parent task",
      instructions: "Parent instructions",
      history: [],
      tools,
      model: { provider: "test", id: "model" },
    } as unknown as AgentRunRequest,
    { name: "test", capabilities: [] },
    {
      task: "Helper task",
      instructions: "Helper instructions",
      model: { provider: "test", id: "model" },
    },
  );
  expect(run.instructions).toContain("Helper instructions");
  expect(run.instructions).not.toContain("Parent instructions");
  expect(run.instructions).toContain("mcp__tool_29");
  expect(run.instructions).toContain("mcp_load_tool");
  expect(run.tools.filter((tool) => typeof tool.catalog === "object")).toHaveLength(30);
});
