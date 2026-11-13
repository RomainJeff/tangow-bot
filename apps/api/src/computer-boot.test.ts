import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@tangow/contracts";
import { createRepos, createThreadEvents } from "@tangow/db";
import type { PgliteDatabase } from "@tangow/db/pglite.test-support";
import { openPgliteDatabase } from "@tangow/db/pglite.test-support";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { FakeSandboxProvider } from "../../../packages/adapters/src/fake-sandbox.js";
import { FakeWorkerProvider } from "../../../packages/adapters/src/fake-worker-provider.js";
import { LocalAgentHomeStore } from "../../../packages/adapters/src/home.js";
import { InMemoryJobQueue } from "../../../packages/adapters/src/wakeup.js";
import { workerFixture } from "../../../packages/adapters/src/worker-fixture.test-support.js";
import { createWorkerLifecycle } from "../../../packages/adapters/src/worker-lifecycle.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

let database: PgliteDatabase;
beforeAll(async () => {
  database = await openPgliteDatabase();
});
afterAll(() => database.close());

it("provisions a new bot's home volumes before its first manual boot", async () => {
  const prisma = database.prisma;
  const fixture = workerFixture(prisma);
  await fixture.seedOwner();
  const spaceId = await fixture.seedSpace();
  await fixture.seedMembership(spaceId);
  const actor = {
    spaceId,
    userId: fixture.userId,
    email: "owner@tangow.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  vi.stubEnv("SANDBOX_PROVIDER", "docker");
  const bot = await createRepos(prisma).createBot(actor, {
    name: "Writer",
    title: "Writer",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  });
  vi.unstubAllEnvs();
  const sandbox = new FakeSandboxProvider();
  const fakeProvision = sandbox.provision.bind(sandbox);
  // A home on volumes belongs to a Docker or E2B computer, so the fake answers as Docker.
  const provision = vi.spyOn(sandbox, "provision").mockImplementation(async (request, context) => ({
    ...(await fakeProvision(request, context)),
    kind: "docker",
  }));
  const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-boot-"));
  const handler = new RPCHandler(
    createRouter({
      prisma,
      sandbox,
      jobs: new InMemoryJobQueue(),
      events: createThreadEvents(prisma),
      home: new LocalAgentHomeStore(dataDir),
      dataDir,
      workers: createWorkerLifecycle({ prisma, provider: new FakeWorkerProvider() }),
      env: { screenProxySecret: "fake-test-secret" },
    } as RouterDeps),
  );

  const { response } = await handler.handle(
    new Request("http://127.0.0.1/rpc/computer/boot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { botId: bot.id } }),
    }),
    { prefix: "/rpc", context: { actor } },
  );

  expect(response?.status).toBe(200);
  const volumes = await prisma.volume.findMany({ where: { spaceId } });
  expect(volumes.map((volume) => volume.kind).sort()).toEqual(["bot_private", "space_shared"]);
  expect(volumes.every((volume) => volume.providerRef)).toBe(true);
  expect(provision.mock.calls[0]![0].volumeHome?.mounts).toHaveLength(2);
});
