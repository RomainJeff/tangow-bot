import type { AgentRunRequest, ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { catalogEntries, lazyCatalogTools } from "../lazy-tool-catalog.js";
import { encodeMessage } from "./framing.js";
import { guestRunInput } from "./guest-input.js";
import { WORKER_LIMITS } from "./limits.js";

const MiB = 1024 * 1024;

/** 30 connector tools of about 60 KiB each: a catalog of about 1.8 MiB behind its fallback. */
const CATALOG = lazyCatalogTools(
  "mcp",
  "mcp",
  "MCP",
  catalogEntries(
    Array.from(
      { length: 30 },
      (_, index): ConnectorTool => ({
        name: `mcp__demo__tool_${index}`,
        description: "d".repeat(60 * 1024),
        inputSchema: { type: "object", properties: {} },
        route: { connectorId: "mcp", resourceId: "srv-demo", toolName: `tool_${index}` },
      }),
    ),
  ),
);

function start(prompt: string) {
  const run = guestRunInput(
    {
      botId: "bot-1",
      threadId: "thread-1",
      prompt,
      instructions: "",
      history: [],
      tools: CATALOG,
      model: { provider: "test", id: "model" },
    } as unknown as AgentRunRequest,
    { name: "pi-native", capabilities: [] },
  );
  const frame = encodeMessage({
    version: 1,
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
    run,
  });
  return {
    entries: run.tools.filter((tool) => typeof tool.catalog === "object").length,
    fallback: run.tools.filter((tool) => tool.catalog === "fallback").map((tool) => tool.name),
    bytes: frame.byteLength,
  };
}

describe("a large catalog in worker.start", () => {
  it("is sent with its fallback marked when it fits the start frame", () => {
    expect(start("Hello.")).toEqual({
      entries: 30,
      fallback: ["mcp_search_tools", "mcp_load_tool", "mcp_execute_tool"],
      bytes: expect.any(Number),
    });
  });

  it("stays behind its fallback when the prompt leaves no room, and the frame keeps its cap", () => {
    const sent = start("p".repeat(6.5 * MiB));

    expect(sent.entries).toBe(0);
    expect(sent.fallback).toEqual([]);
    expect(sent.bytes).toBeLessThanOrEqual(WORKER_LIMITS.controllerFrameBytes);
    const withCatalog = start("p".repeat(5 * MiB));
    expect(withCatalog.entries).toBe(30);
    expect(withCatalog.bytes).toBeLessThanOrEqual(WORKER_LIMITS.controllerFrameBytes);
  });
});
