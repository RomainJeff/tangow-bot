import { RPCHandler } from "@orpc/server/fetch";
import { acquireComputerExecutionLease, releaseComputerExecutionLease } from "@tangow/adapters";
import type { Actor } from "@tangow/contracts";
import {
  ComputerListItemSchema,
  ComputerUpdateAllResultSchema,
  ComputerUpdateSchema,
} from "@tangow/contracts";
import type { PgliteDatabase } from "@tangow/db/pglite.test-support";
import { openPgliteDatabase } from "@tangow/db/pglite.test-support";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeSandboxProvider } from "../../../packages/adapters/src/fake-sandbox.js";
import { InMemoryJobQueue } from "../../../packages/adapters/src/wakeup.js";
import { workerFixture } from "../../../packages/adapters/src/worker-fixture.test-support.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

let database: PgliteDatabase;
let fixture: ReturnType<typeof workerFixture>;
beforeAll(async () => {
  database = await openPgliteDatabase();
  fixture = workerFixture(database.prisma);
  await fixture.seedOwner();
});
afterAll(() => database.close());

it("lists each owned active computer once and queues only idle computers in the current space", async () => {
  const prisma = database.prisma;
  const spaceId = await fixture.seedSpace();
  const otherSpaceId = await fixture.seedSpace();
  const outsider = workerFixture(prisma);
  await outsider.seedOwner();
  const idle = await fixture.seedComputer(spaceId);
  const firstBot = await fixture.seedBot(spaceId, idle.id);
  const secondBot = await fixture.seedBot(spaceId, idle.id);
  await prisma.bot.create({
    data: {
      id: "aaa-foreign-computer-settings-bot",
      spaceId,
      userId: outsider.userId,
      name: "Other owner's bot",
      color: "#000000",
      computerId: idle.id,
    },
  });
  await prisma.bot.create({
    data: {
      id: "aaa-archived-computer-settings-bot",
      spaceId,
      userId: fixture.userId,
      name: "Archived bot",
      color: "#000000",
      computerId: idle.id,
      archivedAt: new Date(),
    },
  });
  const controlled = await fixture.seedComputer(spaceId);
  const controlledBot = await fixture.seedBot(spaceId, controlled.id);
  const executing = await fixture.seedComputer(spaceId);
  const firstExecutingBot = await fixture.seedBot(spaceId, executing.id);
  const secondExecutingBot = await fixture.seedBot(spaceId, executing.id);
  const executingRepresentative =
    firstExecutingBot.id < secondExecutingBot.id ? firstExecutingBot : secondExecutingBot;
  const executingBot =
    executingRepresentative.id === firstExecutingBot.id ? secondExecutingBot : firstExecutingBot;
  const archived = await fixture.seedComputer(spaceId);
  const archivedBot = await fixture.seedBot(spaceId, archived.id);
  await prisma.bot.update({ where: { id: archivedBot.id }, data: { archivedAt: new Date() } });
  const foreignUser = await outsider.seedComputer(spaceId);
  const foreignUserBot = await outsider.seedBot(spaceId, foreignUser.id);
  const foreignSpace = await fixture.seedComputer(otherSpaceId);
  const foreignSpaceBot = await fixture.seedBot(otherSpaceId, foreignSpace.id);
  await prisma.computer.update({
    where: { id: controlled.id },
    data: {
      state: "running",
      controlHolder: "user",
      controlBotId: controlledBot.id,
      controlLeaseId: "active-computer-settings-control",
      controlLeaseExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  const lease = await acquireComputerExecutionLease(prisma, {
    computerId: executing.id,
    botId: executingBot.id,
    runId: "active-computer-settings-turn",
  });
  const current = await fixture.seedComputer(spaceId);
  const currentBot = await fixture.seedBot(spaceId, current.id);
  const neverStarted = await fixture.seedComputer(spaceId);
  const neverStartedBot = await fixture.seedBot(spaceId, neverStarted.id);
  await prisma.computer.updateMany({
    where: { id: { in: [idle.id, controlled.id, executing.id, current.id] } },
    data: { providerRef: "existing-machine" },
  });
  await prisma.computer.update({ where: { id: current.id }, data: { releaseRef: "release-new" } });
  const sandbox = Object.assign(new FakeSandboxProvider(), {
    currentRelease: async () => "release-new",
  });
  const handler = new RPCHandler(
    createRouter({
      prisma,
      sandbox,
      jobs: new InMemoryJobQueue(),
      dataDir: "unused",
      env: { screenProxySecret: "fake-test-secret" },
    } as RouterDeps),
  );
  const actor = {
    spaceId,
    userId: fixture.userId,
    email: "test@tangow.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  async function call(path: string, input: unknown = null) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/computer/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(response.status).toBe(200);
    const body: { json: unknown } = await response.json();
    return body.json;
  }
  try {
    const listed = ComputerListItemSchema.array().parse(await call("list"));
    const representative = firstBot.id < secondBot.id ? firstBot : secondBot;
    expect(listed.map((item) => item.botId).sort()).toEqual(
      [
        representative.id,
        controlledBot.id,
        executingRepresentative.id,
        currentBot.id,
        neverStartedBot.id,
      ].sort(),
    );
    expect(listed.find((item) => item.botId === representative.id)).toMatchObject({
      name: representative.name,
      bots: [firstBot, secondBot]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(({ id, name }) => ({ id, name })),
      status: { state: "stopped", controlHolder: "none", updateAvailable: true },
    });
    expect(
      listed.find((item) => item.botId === executingRepresentative.id)?.status.busyBotName,
    ).toBe(executingBot.name);
    expect(listed.find((item) => item.botId === currentBot.id)?.status.updateAvailable).toBe(false);
    expect(listed.find((item) => item.botId === neverStartedBot.id)?.status.updateAvailable).toBe(
      false,
    );
    expect(sandbox.boxes.size).toBe(0);
    expect(await prisma.computer.findUniqueOrThrow({ where: { id: controlled.id } })).toMatchObject(
      {
        state: "running",
        controlHolder: "user",
        controlBotId: controlledBot.id,
      },
    );

    const result = ComputerUpdateAllResultSchema.parse(await call("updateAll"));
    expect(result.queued).toEqual([
      expect.objectContaining({
        botId: representative.id,
        name: representative.name,
        status: "queued",
      }),
    ]);
    expect(result.skipped.sort((a, b) => a.botId.localeCompare(b.botId))).toEqual(
      [
        { botId: controlledBot.id, name: controlledBot.name, reason: "busy" },
        { botId: executingRepresentative.id, name: executingRepresentative.name, reason: "busy" },
      ].sort((a, b) => a.botId.localeCompare(b.botId)),
    );
    expect(
      await prisma.computerUpdate.findMany({ select: { computerId: true, botId: true } }),
    ).toEqual([{ computerId: idle.id, botId: representative.id }]);
    expect([
      (await prisma.computer.findUniqueOrThrow({ where: { id: idle.id } })).maintenanceId,
    ]).toEqual(result.queued.map((update) => update.id));
    expect(await prisma.computer.findUniqueOrThrow({ where: { id: controlled.id } })).toMatchObject(
      {
        state: "running",
        controlHolder: "user",
        controlBotId: controlledBot.id,
        maintenanceId: null,
      },
    );
    expect(await prisma.computerExecutionLease.count({ where: { computerId: executing.id } })).toBe(
      1,
    );
    expect(sandbox.boxes.size).toBe(0);
    const queued = result.queued[0];
    if (!queued) throw new Error("missing admitted update");
    await prisma.computerUpdate.update({ where: { id: queued.id }, data: { status: "completed" } });
    const foreignCompletion = await prisma.computerUpdate.create({
      data: { computerId: foreignUser.id, botId: foreignUserBot.id, status: "completed" },
    });
    const otherSpaceCompletion = await prisma.computerUpdate.create({
      data: { computerId: foreignSpace.id, botId: foreignSpaceBot.id, status: "completed" },
    });
    for (const input of [undefined, null, {}]) expect(await call("updates", input)).toEqual([]);
    const tracked = ComputerUpdateSchema.array().parse(
      await call("updates", { ids: [queued.id, foreignCompletion.id, otherSpaceCompletion.id] }),
    );
    expect(tracked).toEqual([expect.objectContaining({ id: queued.id, status: "completed" })]);
    expect(await call("updates", { ids: [] })).toEqual([]);
  } finally {
    await releaseComputerExecutionLease(prisma, lease);
  }
});
