import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AgentHomeStore,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionComputer } from "./computer-lifecycle.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("Computer lifecycle concurrent provisioning (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  const userIds: string[] = [];

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
  });

  afterAll(async () => {
    if (!db) return;
    await prisma.organization.deleteMany({ where: { id: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("lets the owner and a granted specialist reconnect the same mission Computer", async () => {
    const id = randomUUID();
    userIds.push(id);
    await prisma.user.create({
      data: { id, name: "Lifecycle test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Lifecycle test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Lifecycle test", isDefault: true },
    });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    const computer = await prisma.computer.create({
      data: {
        spaceId: id,
        userId: id,
        scopeKey: `lifecycle-team-${id}`,
        homeKey: `lifecycle-home-${id}`,
        kind: "fake",
        state: "running",
        providerRef: "mission-provider",
      },
    });
    const owner = await prisma.bot.create({
      data: {
        spaceId: id,
        userId: id,
        name: "Coordinator",
        color: "test-color",
        computerId: computer.id,
      },
    });
    const specialist = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Specialist", color: "test-color" },
    });
    await prisma.computerUsageGrant.create({
      data: { computerId: computer.id, botId: specialist.id },
    });

    let entered = 0;
    let openBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      openBarrier = resolve;
    });
    const fallbackRelease = setTimeout(openBarrier, 25);
    const sandbox = new FakeSandboxProvider();
    const ref = {
      id: "mission-provider",
      botId: computer.homeKey,
      kind: "fake" as const,
      providerRef: "mission-provider",
      fresh: false,
    };
    sandbox.boxes.set(ref.id, {
      ref,
      files: new Map(),
      running: true,
      screens: new Map(),
      screenLeases: new Map(),
    });
    sandbox.provision = async () => {
      entered += 1;
      if (entered === 2) openBarrier();
      await barrier;
      // A concurrent Docker workspace checkpoint writes only homeRevision, preserving
      // booting but letting Prisma's @updatedAt invalidate the activation CAS.
      await prisma.computer.update({
        where: { id: computer.id },
        data: { homeRevision: "checkpoint-during-boot" },
      });
      return ref;
    };
    const deps = {
      prisma,
      sandbox: sandbox as SandboxProvider,
      home: {} as AgentHomeStore,
      jobs: {} as JobPublisher,
      events: {} as ThreadEvents,
    };
    const context = (botId: string): AdapterContext => ({
      operationId: randomUUID(),
      traceId: "lifecycle-race",
      spaceId: id,
      userId: id,
      botId,
      signal: new AbortController().signal,
    });

    try {
      const [ownerRef, specialistRef] = await Promise.all([
        provisionComputer(deps, computer.id, context(owner.id)),
        provisionComputer(deps, computer.id, context(specialist.id)),
      ]);

      expect(ownerRef).toMatchObject({ providerRef: ref.providerRef, fresh: false });
      expect(specialistRef).toMatchObject({ providerRef: ref.providerRef, fresh: false });
      await expect(
        prisma.computer.findUniqueOrThrow({ where: { id: computer.id } }),
      ).resolves.toMatchObject({
        state: "running",
        providerRef: ref.providerRef,
        kind: ref.kind,
      });
    } finally {
      clearTimeout(fallbackRelease);
    }
  });
});
