import { approvalEffectKey } from "@tangow/core/node/approval-effect-key";
import { describe, expect, it, vi } from "vitest";
import {
  approvedCatalogReplay,
  approvedReplayArgs,
  catalogApprovalRequest,
  createApprovedEffectReplayQueue,
} from "./approval-effect.js";
import { InstalledConnectorProvider, verifyMcpInstall } from "./installed-connectors.js";

type RemoteTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };

function mcpServer(tools: RemoteTool[]) {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body =
      init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : init?.body;
    const request = JSON.parse(typeof body === "string" ? body : "{}") as {
      id?: unknown;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string };
    };
    const answer = (result: unknown) => Response.json({ jsonrpc: "2.0", id: request.id, result });
    if (request.method === "initialize") {
      return answer({
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "installed-test", version: "1" },
      });
    }
    if (request.method === "tools/list") {
      return answer({
        tools: tools.map((tool) => ({ inputSchema: { type: "object" }, ...tool })),
      });
    }
    if (request.method === "tools/call") {
      calls.push({ name: request.params?.name ?? "", arguments: request.params?.arguments ?? {} });
      return answer({ content: [{ type: "text", text: "ok" }] });
    }
    return new Response(null, { status: 202 });
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    remote: { fetch, resolveHostname: async () => [{ address: "8.8.8.8", family: 4 as const }] },
  };
}

function mcpInstall(id: string) {
  return {
    id,
    kind: "mcp",
    name: "",
    source: `https://mcp.example.test/${id}`,
    secretId: null,
    createdAt: new Date(0),
    config: { preset: "custom", auth: { type: "none" } },
  };
}

const context = {
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
} as never;

describe("installed MCP connector", () => {
  it("executes an approved lazy call with authoritative normalized arguments", async () => {
    const install = mcpInstall("mcp-approved");
    const server = mcpServer(
      Array.from({ length: 21 }, (_, index) => ({
        name: `operation_${index}`,
        inputSchema:
          index === 20
            ? {
                type: "object",
                properties: { count: { type: "integer", default: 3 } },
                additionalProperties: false,
              }
            : { type: "object" },
      })),
    );
    const prisma = {
      capabilityInstall: {
        findMany: vi.fn().mockResolvedValue([install]),
        findFirst: vi.fn().mockResolvedValue(install),
      },
    };
    const provider = new InstalledConnectorProvider(prisma as never, {} as never, server.remote);
    const execute = (await provider.discoverTools(context))[2]!;
    const marker = "__tangowCatalogTool";
    const approvedRequest = catalogApprovalRequest(
      execute.name,
      { id: "mcp-approved:operation_20", arguments: {} },
      marker,
    );
    const queue = createApprovedEffectReplayQueue([
      { kind: "operation_20", request: approvedRequest },
    ]);
    const replay = approvedCatalogReplay(queue, execute.name, marker, true);
    const resolved = await provider.resolveCall(
      {
        tool: execute.name,
        args: replay.args!,
        executionId: "approved",
        route: execute.route,
      },
      context,
    );
    const args = approvedReplayArgs(queue.take(resolved!.tool.name)!, resolved!.call.args, marker);
    const events = [];

    for await (const event of provider.execute({ ...resolved!.call, args }, context)) {
      events.push(event);
    }

    expect(resolved!.tool.name).toBe("operation_20");
    expect(args).toEqual({ count: 3 });
    expect(approvalEffectKey("run", resolved!.tool.name, args)).toBe(
      approvalEffectKey("run", resolved!.tool.name, resolved!.call.args),
    );
    expect(server.calls).toEqual([{ name: "operation_20", arguments: { count: 3 } }]);
    expect(events).toMatchObject([{ type: "result" }]);
    expect(queue.assertDrained).not.toThrow();
  });

  it("exposes 20 installed tools directly and switches at 21", async () => {
    const discover = (count: number) =>
      new InstalledConnectorProvider(
        {
          capabilityInstall: {
            findMany: vi.fn().mockResolvedValue([mcpInstall("mcp-threshold")]),
          },
        } as never,
        {} as never,
        mcpServer(Array.from({ length: count }, (_, index) => ({ name: `operation_${index}` })))
          .remote,
      ).discoverTools(context);

    const direct = await discover(20);
    expect(direct).toHaveLength(20);
    expect(direct[0]?.name).toBe("operation_0");
    expect(direct.every((tool) => !tool.name.startsWith("installed__"))).toBe(true);

    expect((await discover(21)).map((tool) => tool.name)).toEqual([
      "installed_search_tools",
      "installed_load_tool",
      "installed_execute_tool",
    ]);
  });

  it("gives no installed source to a member's run on a shared bot", async () => {
    const provider = new InstalledConnectorProvider(
      {
        capabilityInstall: { findMany: vi.fn().mockResolvedValue([mcpInstall("mcp-1")]) },
      } as never,
      {} as never,
      mcpServer([{ name: "list_contacts" }]).remote,
    );
    const ownerContext = {
      spaceId: "space-1",
      userId: "user-1",
      signal: new AbortController().signal,
    };

    await expect(provider.discoverTools(ownerContext as never)).resolves.toHaveLength(1);
    await expect(
      provider.discoverTools({ ...ownerContext, memberId: "user-1" } as never),
    ).resolves.toEqual([]);
  });

  it("executes an installed tool whose name matches a catalog control", async () => {
    const install = mcpInstall("mcp-reserved");
    const server = mcpServer([{ name: "__catalog_execute" }]);
    const prisma = {
      capabilityInstall: {
        findMany: vi.fn().mockResolvedValue([install]),
        findFirst: vi.fn().mockResolvedValue(install),
      },
    };
    const provider = new InstalledConnectorProvider(prisma as never, {} as never, server.remote);
    const [tool] = await provider.discoverTools(context);
    const call = { tool: tool!.name, args: {}, executionId: "reserved", route: tool!.route };

    await expect(provider.resolveCall(call, context)).resolves.toBeUndefined();
    const events = [];
    for await (const event of provider.execute(call, context)) events.push(event);

    expect(events).toMatchObject([{ type: "result" }]);
    expect(server.calls).toEqual([{ name: "__catalog_execute", arguments: {} }]);
  });

  it("refuses credentials embedded in a persisted MCP URL", async () => {
    await expect(
      verifyMcpInstall({
        source: "https://connectors.example.test/mcp?access_token=fake-secret",
        config: { preset: "custom", auth: { type: "none" } },
      }),
    ).rejects.toThrow("encrypted credential field");
  });
});
