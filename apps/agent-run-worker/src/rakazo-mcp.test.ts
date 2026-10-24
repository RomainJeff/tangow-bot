import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { GuestTool } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessHost, InformativeBody } from "./harness.js";
import { rakazoMcpServer, rakazoMcpTools } from "./rakazo-mcp.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const object = { type: "object", properties: {} };
const controller = (name: string, extra: Partial<GuestTool> = {}): GuestTool => ({
  name,
  description: `${name} tool`,
  inputSchema: object,
  where: "controller",
  ...extra,
});
const PRODUCT_TOOLS: GuestTool[] = [
  { ...controller("read"), where: "guest" },
  { ...controller("bash"), where: "guest" },
  controller("remember"),
  controller("schedule_create"),
  controller("computer_observe", { readOnly: true }),
];
/** A connector catalog of 30 tools sent with its fallback, as the controller sends a large one. */
const CATALOG_TOOLS: GuestTool[] = [
  controller("mcp_search_tools", { catalog: "fallback", readOnly: true }),
  controller("mcp_load_tool", { catalog: "fallback", readOnly: true }),
  controller("mcp_execute_tool", { catalog: "fallback" }),
  ...Array.from({ length: 30 }, (_, index) =>
    controller(`mcp__demo__tool_${String(index).padStart(2, "0")}`, {
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
      catalog: { via: "mcp_execute_tool", id: `srv-demo:tool_${index}` },
    }),
  ),
];

/** A controller that answers every call with `answer`, recording what reached it. */
function fakeHost(answer: (name: string, args: Record<string, unknown>) => unknown) {
  const announced: InformativeBody[] = [];
  const calls: Array<{ name: string; args: Record<string, unknown>; callId: string }> = [];
  const host: HarnessHost = {
    signal: new AbortController().signal,
    emit: async (body) => {
      announced.push(body);
    },
    decide: async () => {
      throw new Error("Unexpected decision");
    },
    model: async () => {
      throw new Error("Unexpected model call");
    },
    callTool: async (_agent, name, args, callId) => {
      calls.push({ name, args, callId });
      return await answer(name, args);
    },
  };
  return { host, announced, calls };
}

async function connect(
  tools: GuestTool[],
  host: HarnessHost,
  options = { nativeToolSearch: false },
) {
  const screensDir = await mkdtemp(path.join(tmpdir(), "rakazo-mcp-screens-"));
  const server = rakazoMcpServer(tools, host, screensDir, options);
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  serverEnd.onmessage = (message) => void server.send(message as never);
  server.onMessage((message) => void serverEnd.send(message as JSONRPCMessage));
  await serverEnd.start();
  const client = new Client({ name: "test-harness", version: "1" });
  await client.connect(clientEnd);
  cleanups.push(
    () => client.close(),
    () => rm(screensDir, { recursive: true, force: true }),
  );
  return { client, screensDir };
}

describe("the Rakazo MCP server", () => {
  it("lists only controller tools and relays a call to the controller and back", async () => {
    const { host, announced, calls } = fakeHost((name, args) =>
      name === "remember" ? { ok: true, saved: args.content } : "Reminder set for 9:00.",
    );
    const { client } = await connect(PRODUCT_TOOLS, host);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "remember",
      "schedule_create",
      "computer_observe",
    ]);
    expect(tools[2]!.annotations).toEqual({ readOnlyHint: true });

    const remembered = await client.callTool({
      name: "remember",
      arguments: { content: "Prefers tea" },
    });
    const scheduled = await client.callTool({
      name: "schedule_create",
      arguments: { at: "09:00" },
    });

    expect(remembered).toEqual({
      content: [{ type: "text", text: '{"ok":true,"saved":"Prefers tea"}' }],
      isError: false,
    });
    expect(scheduled).toEqual({
      content: [{ type: "text", text: "Reminder set for 9:00." }],
      isError: false,
    });
    expect(calls.map(({ name, args }) => ({ name, args }))).toEqual([
      { name: "remember", args: { content: "Prefers tea" } },
      { name: "schedule_create", args: { at: "09:00" } },
    ]);
    expect(announced).toEqual(
      calls.map(({ name, args, callId }) => ({ type: "tool", name, args, executionId: callId })),
    );
  });

  it("returns a controller refusal as a tool error and an unknown tool as a protocol error", async () => {
    const { host, calls } = fakeHost(() => {
      throw new Error("The action was declined");
    });
    const { client } = await connect(PRODUCT_TOOLS, host);

    expect(await client.callTool({ name: "schedule_create", arguments: {} })).toEqual({
      content: [{ type: "text", text: "The action was declined" }],
      isError: true,
    });
    await expect(client.callTool({ name: "bash", arguments: {} })).rejects.toThrow(
      "Unknown tool bash",
    );
    expect(calls.map(({ name }) => name)).toEqual(["schedule_create"]);
  });

  it("returns an image the controller still sends, and saves it under a name the result gives", async () => {
    const { host } = fakeHost(() => ({
      kind: "agent_tool_result",
      content: [
        { type: "text", text: "computer observed" },
        { type: "image", data: PNG, mimeType: "image/png" },
      ],
    }));
    const { client, screensDir } = await connect(PRODUCT_TOOLS, host);

    const result = await client.callTool({ name: "computer_observe", arguments: {} });

    const [name] = await readdir(screensDir);
    expect(name).toMatch(/^\.rakazo-screen-[0-9a-f-]{36}\.png$/);
    const file = path.join(screensDir, name!);
    expect(result).toEqual({
      content: [
        { type: "text", text: "computer observed" },
        { type: "image", data: PNG, mimeType: "image/png" },
        { type: "text", text: `Screenshot saved at ${file}. Read it to see it again.` },
      ],
      isError: false,
    });
    expect((await readFile(file)).toString("base64")).toBe(PNG);
  });
});

describe("a connector result through the Rakazo MCP server", () => {
  const CONNECTOR_TOOLS: GuestTool[] = [
    controller("mcp__charts__render", {
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    }),
  ];

  it("refuses arguments its schema rejects before the controller sees the call", async () => {
    const { host, announced, calls } = fakeHost(() => "rendered");
    const { client } = await connect(CONNECTOR_TOOLS, host);

    const result = await client.callTool({ name: "mcp__charts__render", arguments: { value: 3 } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Tool arguments are invalid");
    expect(calls).toEqual([]);
    expect(announced).toEqual([]);
  });

  it("reports a refusal the controller returns as a tool error", async () => {
    const { host } = fakeHost(() => ({ error: "MCP tool is not assigned to this bot" }));
    const { client } = await connect(CONNECTOR_TOOLS, host);

    expect(
      await client.callTool({ name: "mcp__charts__render", arguments: { value: "x" } }),
    ).toEqual({
      content: [{ type: "text", text: "MCP tool is not assigned to this bot" }],
      isError: true,
    });
  });

  it("keeps a connector's MCP content, its images and its error flag", async () => {
    const { host } = fakeHost(() => ({
      content: [
        { type: "text", text: "Chart failed halfway" },
        { type: "image", data: PNG, mimeType: "image/png" },
        { type: "resource_link", uri: "https://example.test/chart", name: "chart" },
      ],
      isError: true,
    }));
    const { client, screensDir } = await connect(CONNECTOR_TOOLS, host);

    const result = await client.callTool({
      name: "mcp__charts__render",
      arguments: { value: "x" },
    });

    const [name] = await readdir(screensDir);
    expect(name).toMatch(/^\.rakazo-screen-[0-9a-f-]{36}\.png$/);
    const file = path.join(screensDir, name!);
    expect(result).toEqual({
      content: [
        { type: "text", text: "Chart failed halfway" },
        { type: "image", data: PNG, mimeType: "image/png" },
        { type: "resource_link", uri: "https://example.test/chart", name: "chart" },
        { type: "text", text: `Screenshot saved at ${file}. Read it to see it again.` },
      ],
      isError: true,
    });
    expect((await readFile(file)).toString("base64")).toBe(PNG);
  });

  it("cuts a long result or error to the model's tool result budget, saying so", async () => {
    let answer: () => unknown = () => "a".repeat(20_000);
    const { host } = fakeHost(() => answer());
    const { client } = await connect(CONNECTOR_TOOLS, host);
    const call = () => client.callTool({ name: "mcp__charts__render", arguments: { value: "x" } });
    const cut = `${"a".repeat(11_972)}\n[8028 more characters cut]`;

    expect(await call()).toEqual({ content: [{ type: "text", text: cut }], isError: false });
    answer = () => {
      throw new Error("a".repeat(20_000));
    };
    expect(await call()).toEqual({ content: [{ type: "text", text: cut }], isError: true });
  });
});

describe("a long result with an image through the Rakazo MCP server", () => {
  it("keeps the saved screen's name within the text budget", async () => {
    const { host } = fakeHost(() => ({
      content: [
        { type: "text", text: "a".repeat(12_000) },
        { type: "image", data: PNG, mimeType: "image/png" },
      ],
    }));
    const { client } = await connect(PRODUCT_TOOLS, host);

    const result = await client.callTool({ name: "computer_observe", arguments: {} });

    const texts = (result.content as Array<{ type: string; text?: string }>)
      .filter((block) => block.type === "text")
      .map((block) => block.text!);
    expect(texts.join("").length).toBeLessThanOrEqual(12_000);
    expect(texts[0]).toMatch(/^a+\n\[\d+ more characters cut\]$/);
    expect(texts[1]).toMatch(
      /^Screenshot saved at .+\.rakazo-screen-[0-9a-f-]{36}\.png\. Read it to see it again\.$/,
    );
  });

  it("counts the screens past the budget in one line instead of naming each", async () => {
    const { host } = fakeHost(() => ({
      content: [
        { type: "text", text: "a".repeat(12_000) },
        ...Array.from({ length: 150 }, () => ({ type: "image", data: PNG, mimeType: "image/png" })),
      ],
    }));
    const { client, screensDir } = await connect(PRODUCT_TOOLS, host);

    const result = await client.callTool({ name: "computer_observe", arguments: {} });

    const texts = (result.content as Array<{ type: string; text?: string }>)
      .filter((block) => block.type === "text")
      .map((block) => block.text!);
    expect(texts.join("").length).toBeLessThanOrEqual(12_000);
    const named = texts.filter((text) => text.startsWith("Screenshot saved at ")).length;
    expect(named).toBeGreaterThan(0);
    expect(texts.at(-1)).toBe(`[${150 - named} more screenshots saved in ${screensDir}]`);
    expect(await readdir(screensDir)).toHaveLength(150);
  });
});

describe("a large connector catalog through the Rakazo MCP server", () => {
  it("defers every catalog tool for a harness with native tool search and runs one once on the controller", async () => {
    const { host, announced, calls } = fakeHost(() => "tool-ran");
    const { client } = await connect([...PRODUCT_TOOLS, ...CATALOG_TOOLS], host, {
      nativeToolSearch: true,
    });

    const listed = rakazoMcpTools([...PRODUCT_TOOLS, ...CATALOG_TOOLS], true);
    expect(listed.filter((tool) => tool.exposure === "direct").map((tool) => tool.name)).toEqual([
      "remember",
      "schedule_create",
      "computer_observe",
    ]);
    expect(listed.filter((tool) => tool.exposure === "deferred")).toHaveLength(30);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain("mcp_search_tools");

    const result = await client.callTool({
      name: "mcp__demo__tool_29",
      arguments: { value: "x" },
    });

    expect(result).toEqual({ content: [{ type: "text", text: "tool-ran" }], isError: false });
    expect(calls.map(({ name, args }) => ({ name, args }))).toEqual([
      { name: "mcp_execute_tool", args: { id: "srv-demo:tool_29", arguments: { value: "x" } } },
    ]);
    expect(announced).toEqual([
      {
        type: "tool",
        name: "mcp_execute_tool",
        args: { id: "srv-demo:tool_29", arguments: { value: "x" } },
        executionId: calls[0]!.callId,
      },
    ]);
  });

  it("gives a harness without native tool search the search, load and execute tools only", async () => {
    const { host, calls } = fakeHost((_name, args) => ({
      tools: [{ id: "srv-demo:tool_29" }],
      args,
    }));
    const { client } = await connect(CATALOG_TOOLS, host);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "mcp_search_tools",
      "mcp_load_tool",
      "mcp_execute_tool",
    ]);
    await expect(
      client.callTool({ name: "mcp__demo__tool_29", arguments: { value: "x" } }),
    ).rejects.toThrow("Unknown tool mcp__demo__tool_29");
    await client.callTool({ name: "mcp_search_tools", arguments: { query: "tool 29" } });
    expect(calls.map(({ name, args }) => ({ name, args }))).toEqual([
      { name: "mcp_search_tools", args: { query: "tool 29" } },
    ]);
  });
});
