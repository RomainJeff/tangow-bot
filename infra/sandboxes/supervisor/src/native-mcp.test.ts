import http from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { resolveSupervisorToken } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const docker = vi.hoisted(() => ({
  getContainer: vi.fn(),
  getNetwork: vi.fn(),
  listContainers: vi.fn(),
}));

vi.mock("dockerode", () => ({
  default: class {
    getContainer = docker.getContainer;
    getNetwork = docker.getNetwork;
    listContainers = docker.listContainers;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
  vi.stubEnv("RAKAZO_NATIVE_MCP_UPSTREAM", "http://127.0.0.1:7093");
  vi.stubEnv("RAKAZO_NATIVE_MCP_RELAY_SECRET", "relay-test-secret");
  docker.getContainer.mockReset();
  docker.getNetwork.mockReset();
  docker.listContainers.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("native MCP relay", () => {
  it.each(["GET", "DELETE"])("rejects %s with 405", async (method) => {
    const { supervisorApp } = await import("./index.js");
    const response = await supervisorApp.request("/native-mcp", { method });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("rejects an unknown socket IP and ignores a forged Computer identity", async () => {
    const { supervisorApp } = await import("./index.js");

    const response = await supervisorApp.request("/native-mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer test-ticket",
        "content-type": "application/json",
        "x-rakazo-source-computer": "forged-computer",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });

    expect(response.status).toBe(403);
    expect(docker.listContainers).not.toHaveBeenCalled();
  });

  it("fails closed when the upstream or relay secret is not configured", async () => {
    vi.stubEnv("RAKAZO_NATIVE_MCP_UPSTREAM", "");
    const { supervisorApp } = await import("./index.js");

    const response = await supervisorApp.request("/native-mcp", { method: "POST" });

    expect(response.status).toBe(404);
    expect(docker.listContainers).not.toHaveBeenCalled();
  });

  it("does not expose native tools from published or host networking", async () => {
    const { supervisorApp } = await import("./index.js");
    for (const mode of ["published", "host"]) {
      vi.stubEnv("SANDBOX_SCREEN_NETWORK", mode);
      const response = await supervisorApp.request("/native-mcp", { method: "POST" });
      expect(response.status).toBe(404);
    }
    expect(docker.listContainers).not.toHaveBeenCalled();
  });

  it("rejects oversized MCP requests before resolving or forwarding them", async () => {
    const { supervisorApp } = await import("./index.js");
    const response = await supervisorApp.request("/native-mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1024 * 1024 + 1),
    });

    expect(response.status).toBe(413);
    expect(docker.listContainers).not.toHaveBeenCalled();
  });

  it("resolves the managed Computer from its socket IP and overwrites forged relay headers", async () => {
    let sourceComputer: string | undefined;
    const upstream = http.createServer((request, response) => {
      expect(request.headers.authorization).toBe("Bearer example-bearer");
      const source = request.headers["x-rakazo-source-computer"];
      sourceComputer = Array.isArray(source) ? source[0] : source;
      expect(request.headers["x-rakazo-relay-secret"]).toBe("relay-test-secret");
      response.setHeader("content-type", "application/json");
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstream.address() as AddressInfo;
    vi.stubEnv("RAKAZO_NATIVE_MCP_UPSTREAM", `http://127.0.0.1:${upstreamAddress.port}`);
    docker.listContainers.mockResolvedValue([
      { Id: "computer-stopped" },
      { Id: "computer-running" },
    ]);
    docker.getContainer.mockImplementation((id: string) => ({
      inspect: vi.fn().mockResolvedValue({
        Id: id,
        Config: { Labels: { "rakazo.managed": "true", "rakazo.botId": "bot-1" } },
        State: { Running: id === "computer-running" },
        NetworkSettings: { Networks: { isolated: { IPAddress: "127.0.0.1" } } },
      }),
    }));

    const { supervisorApp } = await import("./index.js");
    const supervisor = serve({ fetch: supervisorApp.fetch, hostname: "127.0.0.1", port: 0 });
    if (!supervisor.listening)
      await new Promise<void>((resolve, reject) => {
        supervisor.once("error", reject);
        supervisor.once("listening", resolve);
      });
    const supervisorAddress = supervisor.address() as AddressInfo;
    const journal: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      journal.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      journal.push(String(chunk));
      return true;
    });

    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const response = await fetch(`http://127.0.0.1:${supervisorAddress.port}/native-mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer example-bearer",
          "content-type": "application/json",
          "x-rakazo-source-computer": "forged-computer",
          "x-rakazo-relay-secret": "forged-secret",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      });
      expect(response.status).toBe(200);
      expect(timeout).toHaveBeenCalledWith(120_000);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(sourceComputer).toBe("computer-running");
      expect(docker.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: { status: ["running"] },
      });
      expect(journal.join("")).not.toContain("example-bearer");
      expect(journal.join("")).not.toContain("relay-test-secret");
    } finally {
      timeout.mockRestore();
      stdout.mockRestore();
      stderr.mockRestore();
      await new Promise<void>((resolve) => supervisor.close(() => resolve()));
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it.each([undefined, [], ["supervisor"], ["rakazo-mcp"]].map((aliases) => ({ aliases })))(
    "repairs an existing supervisor connection whose aliases are $aliases",
    async ({ aliases }) => {
      const order: string[] = [];
      const connect = vi.fn(async () => {
        order.push("connect");
      });
      const disconnect = vi.fn(async () => {
        order.push("disconnect");
      });
      docker.getNetwork.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Containers: { "supervisor-1": {}, "web-1": {} } }),
        connect,
        disconnect,
      });
      docker.getContainer.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({
          NetworkSettings: { Networks: { "computer-network": { Aliases: aliases } } },
        }),
      });
      const { connectComposeScreenPeers } = await import("./index.js");
      await connectComposeScreenPeers("computer-network", {
        Id: "supervisor-1",
        Config: { Labels: {} },
      } as never);
      if (aliases?.includes("rakazo-mcp")) {
        expect(order).toEqual([]);
      } else {
        expect(order).toEqual(["disconnect", "connect"]);
        expect(disconnect).toHaveBeenCalledWith({ Container: "supervisor-1" });
        expect(connect).toHaveBeenCalledWith({
          Container: "supervisor-1",
          EndpointConfig: { Aliases: [...(aliases ?? []), "rakazo-mcp"] },
        });
      }
    },
  );

  it("attaches the supervisor with the native MCP alias", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    docker.getNetwork.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Containers: {} }),
      connect,
    });
    const { connectComposeScreenPeers } = await import("./index.js");

    await connectComposeScreenPeers("computer-network", {
      Id: "supervisor-1",
      Config: { Labels: {} },
    } as never);

    expect(connect).toHaveBeenCalledWith({
      Container: "supervisor-1",
      EndpointConfig: { Aliases: ["rakazo-mcp"] },
    });
  });

  it("rejoins a running Computer's network before starting a native process", async () => {
    // The supervisor was recreated by a redeploy; the Computer kept running on its own network.
    vi.stubEnv("HOSTNAME", "supervisor-host");
    const order: string[] = [];
    const connect = vi.fn(async () => {
      order.push("connect");
    });
    docker.getNetwork.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Containers: { computer: {} } }),
      connect,
    });
    docker.getContainer.mockImplementation((id: string) =>
      id === "supervisor-host"
        ? { inspect: vi.fn().mockResolvedValue({ Id: "supervisor-1", Config: { Labels: {} } }) }
        : {
            inspect: vi.fn().mockResolvedValue({
              Config: {
                Labels: {
                  "rakazo.managed": "true",
                  "rakazo.botId": "bot",
                  "rakazo.spaceId": "space",
                },
              },
              HostConfig: { NetworkMode: "computer-network" },
            }),
            exec: vi.fn(async () => {
              order.push("exec");
              throw new Error("stop after the network step");
            }),
          },
    );
    const { supervisorApp } = await import("./index.js");

    await supervisorApp.request("/computers/computer/native-processes", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
      },
      body: JSON.stringify({ argv: ["codex", "app-server"], cwd: "project" }),
    });

    expect(connect).toHaveBeenCalledWith({
      Container: "supervisor-1",
      EndpointConfig: { Aliases: ["rakazo-mcp"] },
    });
    expect(order[0]).toBe("connect");
  });
});
