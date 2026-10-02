import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { DockerSandboxProvider } from "@rakazo/adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Opt-in command:
// RUN_NATIVE_MCP_DOCKER=1 pnpm exec vitest run packages/testkit/src/native-mcp.docker.test.ts
const enabled = process.env.RUN_NATIVE_MCP_DOCKER === "1";
type DockerContainer = {
  id: string;
  start(): Promise<void>;
  inspect(): Promise<{
    HostConfig: { NetworkMode?: string };
    NetworkSettings: {
      Ports?: Record<string, Array<{ HostPort?: string }> | undefined>;
      Networks?: Record<string, { IPAddress?: string }>;
    };
  }>;
  remove(options: { force: boolean }): Promise<void>;
};
type DockerClient = {
  createContainer(options: Record<string, unknown>): Promise<DockerContainer>;
  getContainer(id: string): { inspect(): ReturnType<DockerContainer["inspect"]> };
  getNetwork(name: string): {
    connect(options: { Container: string; EndpointConfig: { Aliases: string[] } }): Promise<void>;
  };
};
const Docker = createRequire(import.meta.url)("dockerode") as new (options: {
  socketPath: string;
}) => DockerClient;
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });
const supervisorImage = process.env.RAKAZO_NATIVE_MCP_SUPERVISOR_IMAGE;
const computerImage = process.env.RAKAZO_NATIVE_MCP_COMPUTER_IMAGE;

type Campaign = {
  root: string;
  context: AdapterContext;
  supervisor: DockerContainer;
  upstream: DockerContainer;
  sandbox: DockerSandboxProvider;
  computer: ComputerRef;
  otherComputer: ComputerRef;
};

async function waitFor(url: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = await fetch(url)
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("isolated native MCP supervisor did not become ready");
}

async function command(
  sandbox: DockerSandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  script: string,
) {
  const events = [];
  for await (const event of sandbox.execute(
    computer,
    { argv: ["sh", "-c", script], cwd: "." },
    context,
  ))
    events.push(event);
  return events;
}

function output(events: Awaited<ReturnType<typeof command>>) {
  return events
    .filter((event) => event.type === "stdout")
    .map((event) => event.data)
    .join("");
}

function networkAddress(
  info: Awaited<ReturnType<DockerContainer["inspect"]>>,
  networkName: string,
) {
  const address = info.NetworkSettings.Networks?.[networkName]?.IPAddress;
  if (!address) throw new Error("isolated Computer has no network address");
  return address;
}

describe.skipIf(!enabled).sequential("isolated Docker native MCP relay", () => {
  let campaign: Campaign | undefined;

  beforeAll(async () => {
    const runtimeImage = supervisorImage;
    const runtimeComputerImage = computerImage;
    if (!runtimeImage || !runtimeComputerImage)
      throw new Error(
        "RUN_NATIVE_MCP_DOCKER requires RAKAZO_NATIVE_MCP_SUPERVISOR_IMAGE and RAKAZO_NATIVE_MCP_COMPUTER_IMAGE",
      );
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-native-mcp-"));
    const botId = "native-mcp-bot";
    const relaySecret = `relay-${randomUUID()}`;
    const supervisorToken = `supervisor-${randomUUID()}`;
    const context: AdapterContext = {
      operationId: "native-mcp-docker",
      traceId: "native-mcp-docker",
      spaceId: "native-mcp-space",
      userId: "native-mcp-user",
      botId,
      signal: AbortSignal.timeout(90_000),
    };
    await mkdir(path.join(root, "homes", botId), { recursive: true });
    await mkdir(path.join(root, "homes", "native-mcp-other-bot"), { recursive: true });
    let supervisor: DockerContainer | undefined;
    let upstream: DockerContainer | undefined;
    let computer: ComputerRef | undefined;
    let otherComputer: ComputerRef | undefined;
    let sandbox: DockerSandboxProvider | undefined;
    try {
      supervisor = await docker.createContainer({
        Image: runtimeImage,
        Cmd: ["pnpm", "--filter", "@rakazo/sandbox-supervisor", "start"],
        Env: [
          "DATA_DIR=/data",
          "SUPERVISOR_HOST=0.0.0.0",
          "SUPERVISOR_PORT=7091",
          "DOCKER_SOCKET=/var/run/docker.sock",
          `RAKAZO_COMPUTER_IMAGE=${runtimeComputerImage}`,
          `SANDBOX_SUPERVISOR_TOKEN=${supervisorToken}`,
          "SANDBOX_SCREEN_NETWORK=isolated",
          "RAKAZO_NATIVE_MCP_UPSTREAM=http://native-mcp-upstream:7093",
          `RAKAZO_NATIVE_MCP_RELAY_SECRET=${relaySecret}`,
        ],
        ExposedPorts: { "7091/tcp": {} },
        HostConfig: {
          Binds: [`${root}:/data`, "/var/run/docker.sock:/var/run/docker.sock"],
          PortBindings: { "7091/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
        },
      });
      await supervisor.start();
      const supervisorInfo = await supervisor.inspect();
      const port = supervisorInfo.NetworkSettings.Ports?.["7091/tcp"]?.[0]?.HostPort;
      if (!port) throw new Error("isolated supervisor has no published port");
      const supervisorUrl = `http://127.0.0.1:${port}`;
      await waitFor(`${supervisorUrl}/health`);
      sandbox = new DockerSandboxProvider(supervisorUrl, supervisorToken);
      computer = await sandbox.provision({ botId, homePath: `/data/homes/${botId}` }, context);
      otherComputer = await sandbox.provision(
        { botId: "native-mcp-other-bot", homePath: "/data/homes/native-mcp-other-bot" },
        { ...context, botId: "native-mcp-other-bot" },
      );
      const computerInfo = await docker.getContainer(computer.id).inspect();
      const networkName = computerInfo.HostConfig.NetworkMode;
      if (!networkName) throw new Error("isolated Computer has no network");
      const upstreamProgram = [
        "const http=require('node:http');",
        `const expectedSource=${JSON.stringify(computer.id)};`,
        "http.createServer((req,res)=>{",
        "if(!req.headers.authorization){res.statusCode=401;return res.end('missing bearer')}",
        "let body='';req.on('data',c=>body+=c);req.on('end',()=>{",
        "require('node:fs').appendFileSync('/data/native-mcp-requests.jsonl',JSON.stringify({body,source:req.headers['x-rakazo-source-computer']})+'\\n');",
        "if(req.headers.authorization==='Bearer '+expectedSource&&req.headers['x-rakazo-source-computer']!==expectedSource){res.statusCode=403;return res.end('source mismatch')}",
        "res.setHeader('content-type','application/json');res.end(JSON.stringify({relayed:JSON.parse(body).method}))})}).listen(7093,'0.0.0.0');",
      ].join("");
      upstream = await docker.createContainer({
        Image: runtimeImage,
        Cmd: ["node", "-e", upstreamProgram],
        HostConfig: { Binds: [`${root}:/data`] },
      });
      await upstream.start();
      await docker
        .getNetwork(networkName)
        .connect({ Container: upstream.id, EndpointConfig: { Aliases: ["native-mcp-upstream"] } });
      campaign = { root, context, supervisor, upstream, sandbox, computer, otherComputer };
    } catch (error) {
      if (sandbox && computer) await sandbox.destroy(computer, context).catch(() => undefined);
      if (sandbox && otherComputer)
        await sandbox
          .destroy(otherComputer, { ...context, botId: "native-mcp-other-bot" })
          .catch(() => undefined);
      await upstream?.remove({ force: true }).catch(() => undefined);
      await supervisor?.remove({ force: true }).catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }, 90_000);

  afterAll(async () => {
    if (!campaign) return;
    const { sandbox, computer, otherComputer, context, upstream, supervisor, root } = campaign;
    await sandbox.destroy(computer, context).catch(() => undefined);
    await sandbox
      .destroy(otherComputer, { ...context, botId: "native-mcp-other-bot" })
      .catch(() => undefined);
    await upstream.remove({ force: true }).catch(() => undefined);
    await supervisor.remove({ force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it("relays initialize, tools/list and tools/call from one Computer with its resolved identity", async () => {
    const { sandbox, computer, context, root } = campaign!;
    for (const method of ["initialize", "tools/list", "tools/call"]) {
      const result = await command(
        sandbox,
        computer,
        context,
        `curl -fsS -H 'authorization: Bearer ${computer.id}' -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"${method}"}' http://rakazo-mcp:7091/native-mcp`,
      );
      expect(output(result)).toContain(`"relayed":"${method}"`);
    }
    const requests = await readFile(path.join(root, "native-mcp-requests.jsonl"), "utf8");
    expect(requests.split("\n").filter(Boolean)).toHaveLength(3);
    expect(requests).toContain(`"source":"${computer.id}"`);
  }, 60_000);

  it("rejects missing bearer and source impersonation while isolating Computer IPs", async () => {
    const { sandbox, computer, otherComputer, context, root } = campaign!;
    const noBearer = await command(
      sandbox,
      computer,
      context,
      "curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' --data '{}' http://rakazo-mcp:7091/native-mcp",
    );
    expect(output(noBearer)).toContain("401");
    const impersonation = await command(
      sandbox,
      otherComputer,
      { ...context, botId: "native-mcp-other-bot" },
      `curl -sS -o /dev/null -w '%{http_code}' -H 'authorization: Bearer ${computer.id}' -H 'content-type: application/json' --data '{}' http://rakazo-mcp:7091/native-mcp`,
    );
    expect(output(impersonation)).toContain("403");
    const requests = (await readFile(path.join(root, "native-mcp-requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { source?: string });
    expect(requests.at(-1)).toEqual({ body: "{}", source: otherComputer.id });

    const computerInfo = await docker.getContainer(computer.id).inspect();
    const otherComputerInfo = await docker.getContainer(otherComputer.id).inspect();
    const computerNetwork = computerInfo.HostConfig.NetworkMode;
    const otherComputerNetwork = otherComputerInfo.HostConfig.NetworkMode;
    if (!computerNetwork || !otherComputerNetwork)
      throw new Error("isolated Computers have no network");
    for (const [from, target, targetIp] of [
      [computer, context, networkAddress(otherComputerInfo, otherComputerNetwork)],
      [
        otherComputer,
        { ...context, botId: "native-mcp-other-bot" },
        networkAddress(computerInfo, computerNetwork),
      ],
    ] as const) {
      const isolated = await command(
        sandbox,
        from,
        target,
        `curl -fsS --connect-timeout 2 --max-time 3 http://${targetIp}:6080/embed.html`,
      );
      expect(isolated.at(-1)).toMatchObject({ type: "exit" });
      expect([7, 28]).toContain((isolated.at(-1) as { code?: unknown }).code);
    }
  }, 60_000);
});
