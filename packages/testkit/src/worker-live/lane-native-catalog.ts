import assert from "node:assert/strict";
import type { ConnectorProvider } from "@rakazo/adapter-kit";
import { EncryptedSecretStore, McpConnector } from "@rakazo/adapters";
import { latestCard } from "../index.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "../model-emulator.js";
import { finish, liveRun } from "./run.js";
import type { Lane, Live } from "./session.js";

const CANARY = "FAKE-n13-controller-only-mcp-key";
const LONG = `publish_${"note_".repeat(16)}`;
const NAMES = [LONG, "notes.write", "notes_write"];

async function catalogRun(live: Live, deferred: boolean) {
  const names = deferred
    ? [...NAMES, ...Array.from({ length: 27 }, (_, index) => `lookup_${index}`)]
    : NAMES;
  const schemas = names.map((name, index) => ({
    name,
    description: `catalogneedle${index}x`,
    inputSchema: {
      type: "object",
      properties: { value: { type: "string", description: `n13-schema-${index}-end` } },
      required: ["value"],
      additionalProperties: false,
    },
  }));
  const executed: string[] = [];
  let authenticated = 0;
  const network = {
    resolveHostname: async () => [{ address: "8.8.8.8", family: 4 as const }],
    async fetch(input: string | URL | Request, init?: RequestInit) {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method !== "POST") return new Response(null, { status: 405 });
      assert.equal(request.headers.get("authorization"), `Bearer ${CANARY}`);
      authenticated += 1;
      const rpc: unknown = await request.json();
      assert.ok(typeof rpc === "object" && rpc !== null && "method" in rpc);
      const id = "id" in rpc ? rpc.id : undefined;
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
      if (rpc.method === "initialize")
        return reply({
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "synthetic-catalog", version: "1" },
        });
      if (rpc.method === "tools/list") return reply({ tools: schemas });
      if (rpc.method === "tools/call") {
        assert.ok("params" in rpc && typeof rpc.params === "object" && rpc.params !== null);
        assert.ok("name" in rpc.params && typeof rpc.params.name === "string");
        executed.push(rpc.params.name);
        return reply({ content: [{ type: "text", text: `published-on-controller ${CANARY}` }] });
      }
      return new Response(null, { status: 202 });
    },
  };
  let connector: McpConnector | undefined;
  const getConnector = () => {
    assert.ok(connector, "MCP fixture must be configured before the run starts");
    return connector;
  };
  const tools: ConnectorProvider = {
    describe: () => getConnector().describe(),
    discoverTools: (ctx) => getConnector().discoverTools(ctx),
    resolveCall: (request, ctx) => getConnector().resolveCall(request, ctx),
    execute: (request, ctx) => getConnector().execute(request, ctx),
  };
  const assigned: string[] = [];
  let prefix = "";
  const inspect = (request: ModelEmulatorRequest, selected: number[]) => {
    const system = JSON.stringify(request.messages.filter((message) => message.role === "system"));
    if (prefix) assert.equal(system, prefix, "N8 prefix changed within the attempt");
    prefix = system;
    for (const [index] of names.entries()) {
      const matches =
        request.tools?.filter((tool) =>
          JSON.stringify(tool.function.parameters).includes(`n13-schema-${index}-end`),
        ) ?? [];
      assert.equal(matches.length, selected.includes(index) ? 1 : 0);
      if (matches[0]) assigned[index] = matches[0].function.name;
    }
    assert.equal(new Set(assigned.filter(Boolean)).size, assigned.filter(Boolean).length);
  };
  const searchSteps: ModelEmulatorStep[] = deferred
    ? NAMES.flatMap((_, index): ModelEmulatorStep[] => [
        {
          expect(request) {
            inspect(
              request,
              Array.from({ length: index }, (_, i) => i),
            );
            assert.ok(request.tools?.some((tool) => tool.function.name === "tool_search"));
          },
          response: {
            type: "tool",
            id: `search-${index}`,
            name: "tool_search",
            arguments: { query: `catalogneedle${index}x`, limit: 1 },
          },
        },
      ])
    : [];
  let revoke = async () => {};
  const worker = await liveRun(live, {
    computer: "none",
    tools,
    steps: [
      ...searchSteps,
      {
        expect(request) {
          inspect(request, [0, 1, 2]);
        },
        response: () => {
          const name = assigned[0];
          assert.ok(name);
          return {
            type: "tool",
            id: "publish-approved",
            name,
            arguments: { value: "synthetic-note" },
          };
        },
      },
      { expect() {}, response: { type: "text", text: "Waiting for approval." } },
      {
        async expect(request) {
          prefix = "";
          assert.ok(JSON.stringify(request.messages).includes("published-on-controller"));
          assert.equal(executed.length, 1);
          if (!deferred) inspect(request, [0, 1, 2]);
          await revoke();
        },
        response: deferred
          ? {
              type: "tool",
              id: "search-revoked",
              name: "tool_search",
              arguments: { query: "catalogneedle1x", limit: 1 },
            }
          : () => {
              assert.ok(assigned[1]);
              return {
                type: "tool",
                id: "revoked",
                name: assigned[1],
                arguments: { value: "must-not-publish" },
              };
            },
      },
      ...(deferred
        ? [
            {
              expect(request) {
                inspect(request, [1]);
              },
              response: () => {
                assert.ok(assigned[1]);
                return {
                  type: "tool",
                  id: "revoked",
                  name: assigned[1],
                  arguments: { value: "must-not-publish" },
                };
              },
            } satisfies ModelEmulatorStep,
          ]
        : []),
      ...finish("Catalog validation completed", (request) => {
        const results = JSON.stringify(
          request.messages.filter((message) => message.role === "tool"),
        );
        assert.match(results, /unknown or not authorized|not authorized|not assigned|disabled/i);
        assert.equal(executed.length, 1);
      }),
    ],
  });
  const secrets = new EncryptedSecretStore("n13-catalog-synthetic-encryption-key");
  try {
    const sealed = await secrets.put(JSON.stringify({ secret: CANARY }), {
      operationId: "catalog",
      traceId: "catalog",
      spaceId: worker.run.spaceId,
      userId: worker.run.userId,
      signal: new AbortController().signal,
    });
    await worker.run.prisma.secret.create({
      data: {
        id: sealed.id,
        userId: worker.run.userId,
        spaceId: worker.run.spaceId,
        kind: "mcp",
        ciphertext: sealed.ciphertext,
      },
    });
    connector = new McpConnector(worker.run.prisma, secrets, { network });
    const server = await worker.run.prisma.mcpServer.create({
      data: {
        spaceId: worker.run.spaceId,
        userId: worker.run.userId,
        slug: "n13",
        name: "Synthetic catalog",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/mcp",
        secretId: sealed.id,
      },
    });
    await worker.run.prisma.botMcpServer.create({
      data: {
        spaceId: worker.run.spaceId,
        userId: worker.run.userId,
        botId: worker.run.bot.id,
        serverId: server.id,
      },
    });
    revoke = async () => {
      await worker.run.prisma.mcpServer.update({
        where: { id: server.id },
        data: { enabled: false },
      });
    };
    await worker.run.prisma.actionApprovalRule.create({
      data: {
        spaceId: worker.run.spaceId,
        createdByUserId: worker.run.userId,
        effect: "require_approval",
        matchKind: "tool",
        matchValue: `mcp__n13__${LONG}`,
      },
    });
    const runId = await worker.send(
      "Publish one synthetic note after approval. Keep the outcome private.",
    );
    if ((await worker.status(runId)) !== "waiting_input") worker.run.model.assertComplete();
    assert.equal(await worker.status(runId), "waiting_input");
    assert.equal(executed.length, 0);
    const card = await latestCard(worker.run.prisma, runId);
    assert.ok(
      await worker.run.events.answerRunInput({
        spaceId: worker.run.spaceId,
        threadId: worker.run.thread.id,
        runId,
        messageId: card.id,
        answeredByUserId: worker.run.userId,
        answer: "allow",
      }),
    );
    worker.run.restart();
    await worker.run.continueRun(runId);
    worker.run.model.assertComplete();
    await worker.completed(runId);
    assert.deepEqual(executed, [LONG]);
    assert.ok(authenticated > 0);
    const entries = await worker.run.runEntries(runId);
    const frames = worker.seen.map(({ frame }) => Buffer.from(frame).toString()).join("\n");
    for (const content of [
      frames,
      JSON.stringify(worker.run.model.rawRequests),
      JSON.stringify(entries),
    ])
      assert.ok(!content.includes(CANARY), "Controller secret crossed the redaction boundary");
    assert.ok(
      entries.some(
        (entry) =>
          entry.type === "tool.result" && entry.payload.output.includes("published-on-controller"),
      ),
    );
    assert.equal(await worker.run.prisma.computer.count(), 0);
    return {
      exposure: deferred ? "deferred" : "direct",
      catalogSize: names.length,
      assignedNames: assigned.slice(0, 3),
      approvedEffects: executed.length,
      revokedEffects: 0,
      canaryAbsentFromFramesModelAndCanonicalLog: true,
      controllerAuthenticated: true,
      computerRows: 0,
      prefixStableWithinAttempt: true,
      attempts: (await worker.attempts(runId)).map(({ workerState }) => workerState),
    };
  } finally {
    await connector?.close();
    await worker.close();
  }
}

export const laneNativeCatalog: Lane = {
  id: "native-catalog",
  issue: "N13 native MCP catalog transport and controller authority",
  scenario:
    "Real Pi in E2B uses direct and deferred synthetic MCP catalogs with long and colliding names, approval, revocation and fake secret canaries",
  passWhen:
    "Only selected deferred schemas reach the model, SDK-assigned names remain distinct, one approved effect executes and revocation prevents another, with secrets absent from worker/model/canonical history",
  async run(live) {
    assert.equal(live.config.harness ?? "pi-native", "pi-native");
    const direct = await catalogRun(live, false);
    const deferred = await catalogRun(live, true);
    return {
      pass: true,
      observed: {
        model: "protocol emulator",
        mcp: "synthetic authenticated protocol fixture",
        direct,
        deferred,
      },
    };
  },
};
