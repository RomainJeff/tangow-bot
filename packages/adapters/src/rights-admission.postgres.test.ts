import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeEffectiveMcpAccess, isMcpToolAdmitted } from "./delegated-tasks.js";

// NOT RUN in this sandbox (no Docker/Postgres). Terra runs this at review with:
//   VERIFY_DATABASE=1 DATABASE_URL=<test db> pnpm exec vitest run packages/adapters/src/rights-admission.postgres.test.ts
const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

/**
 * T07:4 correction (Terra review — B2/B3, plus the concurrency finding on the axe standards):
 * `computeEffectiveMcpAccess`/`isMcpToolAdmitted` must observe a `BotMcpServer` row deleted
 * (or its `McpServer` disabled) *after* a `scoped_tasks.delegationCeiling` was persisted, on
 * the very next call, without any change to the immutable ceiling itself. This is the same
 * mechanism the offline mirror in `delegated-tasks.test.ts` exercises against a fake Prisma;
 * here it runs against a real transaction/read path (no fake `findMany`/`findFirst`
 * implementation to get subtly wrong).
 *
 * Naming correction: the two tests below are honestly labelled "sequential" — `before`, then
 * the mutation, then `after`, in program order — they prove the mechanism re-reads live state,
 * not that a real race between an in-flight admission and a concurrent revocation is safe.
 *
 * T07:6 correction (root decision, on Terra's concurrency finding): the third test —
 * previously labelled "genuinely concurrent" — is renamed honestly to "concurrent
 * connections, no forced interference". Two independent Postgres connections issue an
 * admission check and a revocation via `Promise.all` with no artificial delay, but nothing
 * forces the two operations to actually interleave inside Postgres: the read and the delete
 * touch different rows (`scoped_tasks`/`BotMcpServer`) with no shared lock between them, so
 * the pool, the network, and the scheduler are free to run them in either order, or fully
 * sequentially — this test cannot tell the difference, and does not claim to. It still has
 * value (no throw, no deadlock, under real concurrent connections, and the post-settlement
 * call always reflects the revocation), but it is not evidence about the linearization
 * boundary itself.
 *
 * A real race — forcing the two operations to actually contend for the same row at the same
 * instant (e.g. a `SELECT ... FOR UPDATE` on the `BotMcpServer` row held by one connection
 * while the other's admission read is provably blocked on it, released only on an explicit
 * signal) — is left to the backlog, not attempted here: this narrow delivery's budget does
 * not cover building and validating that harness. Admission is still the declared
 * linearization point (documented in `rakazo-mcp-bridge.ts` and `mcp-connector.ts`): a call
 * admitted before a revocation commits is allowed to complete. Proving the narrower window
 * (revocation while a callback is already in flight after admission) would additionally need
 * a lock or lease held across the callback's entire execution, which no seam here holds
 * today — also backlog, not silently assumed.
 */
describePostgres("computeEffectiveMcpAccess / isMcpToolAdmitted (PostgreSQL contract)", () => {
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  let dbB: ReturnType<typeof createDb>;
  const orgIds: string[] = [];

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    // A second, independent connection pool — real concurrency needs two distinct
    // connections, not two promises sharing one client's connection queue.
    dbB = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    if (!db) return;
    await prisma.botMcpServer.deleteMany({ where: { userId: { in: orgIds } } });
    await prisma.mcpServer.deleteMany({ where: { userId: { in: orgIds } } });
    await prisma.scopedTask.deleteMany({ where: { userId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: orgIds } } });
    await db.prisma.$disconnect();
    await db.pool.end();
    await dbB.prisma.$disconnect();
    await dbB.pool.end();
  });

  async function setup() {
    const id = randomUUID();
    orgIds.push(id);
    await prisma.user.create({
      data: { id, name: "T07:4 test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "T07:4 test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "T07:4 test", isDefault: true },
    });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    const coordinator = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Coordinator", color: "test-color" },
    });
    const coordinatorThread = await prisma.thread.create({
      data: { spaceId: id, userId: id, botId: coordinator.id },
    });
    const specialist = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Specialist", color: "test-color" },
    });
    const specialistThread = await prisma.thread.create({
      data: { spaceId: id, userId: id, kind: "work" },
    });
    const server = await prisma.mcpServer.create({
      data: {
        spaceId: id,
        userId: id,
        slug: `server-${id}`,
        name: "Test connector",
        transport: "stdio",
        enabled: true,
      },
    });
    await prisma.botMcpServer.create({
      data: { spaceId: id, userId: id, botId: coordinator.id, serverId: server.id },
    });
    await prisma.botMcpServer.create({
      data: { spaceId: id, userId: id, botId: specialist.id, serverId: server.id },
    });
    const scopedTask = await prisma.scopedTask.create({
      data: {
        spaceId: id,
        userId: id,
        coordinatorBotId: coordinator.id,
        coordinatorThreadId: coordinatorThread.id,
        executorBotId: specialist.id,
        specialistThreadId: specialistThread.id,
        rootScopedTaskId: "placeholder",
        depth: 0,
        profileBotId: coordinator.id,
        brief: "Test brief",
        harness: "codex-native",
        executionTarget: "default",
        choiceVersion: 1,
        delegationCeiling: { [server.id]: { allowAllTools: true, allowedTools: [] } },
        spawnKey: `spawn-${id}`,
        status: "dispatched",
      },
    });
    await prisma.scopedTask.update({
      where: { id: scopedTask.id },
      data: { rootScopedTaskId: scopedTask.id },
    });
    return { id, coordinator, specialist, server, scopedTask };
  }

  it("(sequential, not a race) grants the tool while the coordinator's assignment exists, then refuses it on the very next call after the assignment is deleted — the persisted ceiling never changes", async () => {
    const { specialist, server, scopedTask } = await setup();

    const before = await computeEffectiveMcpAccess(prisma, specialist.id);
    expect(before[server.id]).toEqual({ allowAllTools: true, allowedTools: [] });

    await prisma.botMcpServer.deleteMany({ where: { botId: scopedTask.coordinatorBotId } });

    const after = await computeEffectiveMcpAccess(prisma, specialist.id);
    expect(after[server.id]).toBeUndefined();

    const reread = await prisma.scopedTask.findUniqueOrThrow({ where: { id: scopedTask.id } });
    expect(reread.delegationCeiling).toEqual({
      [server.id]: { allowAllTools: true, allowedTools: [] },
    });
  });

  it("(sequential, not a race) also refuses the tool when the server itself is disabled, rather than the assignment removed", async () => {
    const { specialist, server } = await setup();

    const before = await isMcpToolAdmitted(prisma, {
      botId: specialist.id,
      serverId: server.id,
      toolName: "anything",
    });
    expect(before).toBe(true);

    await prisma.mcpServer.update({ where: { id: server.id }, data: { enabled: false } });

    const after = await isMcpToolAdmitted(prisma, {
      botId: specialist.id,
      serverId: server.id,
      toolName: "anything",
    });
    expect(after).toBe(false);
  });

  it("(concurrent connections, no forced interference) an admission check and a revocation issued together over two connections never throw or deadlock, and the next call after both settle always reflects the revocation", async () => {
    const { specialist, server, scopedTask } = await setup();

    const [raceResult] = await Promise.all([
      isMcpToolAdmitted(prisma, { botId: specialist.id, serverId: server.id, toolName: "x" }),
      dbB.prisma.botMcpServer.deleteMany({ where: { botId: scopedTask.coordinatorBotId } }),
    ]);
    // Nothing forces these two operations to actually contend for the same row at the same
    // instant (see the file-level comment) — this does not prove the linearization boundary,
    // only that issuing them together over two real connections completes cleanly.
    expect(typeof raceResult).toBe("boolean");

    const settled = await isMcpToolAdmitted(prisma, {
      botId: specialist.id,
      serverId: server.id,
      toolName: "x",
    });
    expect(settled).toBe(false);
  });
});
