import { RPCHandler } from "@orpc/server/fetch";
import {
  acquireComputerExecutionLease,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
} from "@tangow/adapters";
import type { PgliteDatabase } from "@tangow/db/pglite.test-support";
import { openPgliteDatabase } from "@tangow/db/pglite.test-support";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeSandboxProvider } from "../../../packages/adapters/src/fake-sandbox.js";
import { InMemoryJobQueue } from "../../../packages/adapters/src/wakeup.js";
import { workerFixture } from "../../../packages/adapters/src/worker-fixture.test-support.js";
import { createWorkerLifecycle } from "../../../packages/adapters/src/worker-lifecycle.js";
import { toComputerStatus } from "./computer-status.js";
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

it.each(["screen", "lease", "stop"])(
  "preserves a running sibling's %s during a dedicated home move",
  async (operation) => {
    const prisma = database.prisma;
    const spaceId = await fixture.seedSpace();
    const source = await fixture.seedComputer(spaceId, { scope: "dedicated" });
    const sibling = await fixture.seedComputer(spaceId);
    const bot = await fixture.seedBot(spaceId, sibling.id);
    await prisma.computer.update({ where: { id: sibling.id }, data: { state: "running" } });
    const workers = createWorkerLifecycle({ prisma, provider: null });
    const existingLease =
      operation === "lease"
        ? await acquireComputerExecutionLease(prisma, {
            computerId: sibling.id,
            botId: bot.id,
            runId: "current-turn",
          })
        : null;
    const reservation = await workers.reserveHomeMove(source.id);
    if (!("marker" in reservation)) throw new Error(reservation.blocker);
    try {
      if (operation === "screen") {
        const computer = await prisma.computer.findUniqueOrThrow({ where: { id: sibling.id } });
        expect(toComputerStatus(bot.id, 0, computer)).toMatchObject({
          state: "running",
          screenAvailable: true,
        });
      } else if (operation === "lease") {
        expect(await renewComputerExecutionLease(prisma, existingLease)).toBe(true);
        await releaseComputerExecutionLease(prisma, existingLease);
        const lease = await acquireComputerExecutionLease(prisma, {
          computerId: sibling.id,
          botId: bot.id,
          runId: "next-turn",
        });
        expect(lease).toMatchObject({ computerId: sibling.id, botId: bot.id, runId: "next-turn" });
        await releaseComputerExecutionLease(prisma, lease);
      } else {
        const handler = new RPCHandler(
          createRouter({
            prisma,
            sandbox: new FakeSandboxProvider(),
            jobs: new InMemoryJobQueue(),
            dataDir: "unused",
            env: { screenProxySecret: "fake-test-secret" },
          } as RouterDeps),
        );
        const { response } = await handler.handle(
          new Request("http://127.0.0.1/rpc/computer/stop", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json: { botId: bot.id } }),
          }),
          {
            prefix: "/rpc",
            context: {
              actor: {
                spaceId,
                userId: fixture.userId,
                email: "test@rakazo.test",
                isDeploymentOwner: true,
              },
            },
          },
        );
        expect(response.status).toBe(200);
        expect((await prisma.computer.findUniqueOrThrow({ where: { id: sibling.id } })).state).toBe(
          "stopped",
        );
      }
    } finally {
      await workers.releaseHomeMove(reservation.marker);
    }
  },
);
