import type {
  AdapterContext,
  ComputerRef,
  PageBrowserCommand,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  E2BSandboxEmulator,
  InMemoryJobQueue,
  recoverBrowserApprovalScreens,
} from "@rakazo/adapters";
import { browserApprovalCheckpointOf } from "@rakazo/db";
import { afterEach, expect, it, vi } from "vitest";
import type { RouterDeps } from "../../../apps/api/src/router.js";
import { createRouter } from "../../../apps/api/src/router.js";
import { stopThreadRuns } from "../../../apps/api/src/thread-target.js";
import { releaseBrowserApprovalScreen } from "../../adapters/src/browser-approval.js";
import { BACKGROUND_WORK_LAUNCH } from "../../adapters/src/computer-idle.js";
import { renewComputerExecutionLease } from "../../adapters/src/computer-lifecycle.js";
import { dockerE2BMachine } from "../../adapters/src/e2b-machine.test-support.js";
import { latestCard } from "./index.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function pausedBrowser(
  scope: "team" | "dedicated",
  options: {
    databaseUrl?: string;
    beforeApproval?: (
      computer: ComputerRef,
      context: AdapterContext,
      computerId: string,
    ) => Promise<void>;
    execute?: SandboxProvider["execute"];
    resumed?: () => Promise<void>;
    releasing?: () => Promise<void>;
  } = {},
) {
  let effects = 0;
  const releases: AdapterContext[] = [];
  const state = { failSetup: false, failRelease: false, pauseAfterApproval: false };
  class Computer extends E2BSandboxEmulator {
    async pageBrowser(computer: ComputerRef, request: PageBrowserCommand, context: AdapterContext) {
      await this.connectScreen(computer, {}, context);
      if (request.command === "snapshot")
        await options.beforeApproval?.(computer, context, run.bot.computerId!);
      if (request.command === "act") effects++;
      return {
        ok: true,
        url: "https://example.test/form",
        title: "Form",
        elements: [],
        tree: "(no interactive elements)",
        completed: 1,
      };
    }
    override async releaseScreen(computer: ComputerRef, context: AdapterContext) {
      releases.push(context);
      await options.releasing?.();
      if (state.failRelease) throw new Error("Synthetic release failure");
      await super.releaseScreen(computer, context);
    }
  }
  const sandbox = new Computer();
  if (options.execute) sandbox.execute = options.execute;
  let calls = 0;
  const run = await startWorkerRun({
    steps: [],
    databaseUrl: options.databaseUrl,
    computerScope: scope,
    sandbox,
    memoryProviders: {
      resolve: async () => {
        if (state.failSetup) throw new Error("Synthetic setup failure");
        return null;
      },
    },
    runtime: () => ({
      describe: () => ({
        id: "fixture",
        contractVersion: "1",
        adapterVersion: "0",
        capabilities: { scripted: false, streaming: false },
      }),
      abort: async () => {},
      async *run(request) {
        if (calls++ === 0) {
          expect(await request.executeTool!("browser_snapshot", {}, "snapshot")).toMatchObject({
            title: "Form",
          });
          await request.executeTool!(
            "browser_act",
            { actions: [{ kind: "click", ref: "original-node" }] },
            "act",
          );
        } else {
          await options.resumed?.();
          await request.executeTool!(
            "browser_act",
            { actions: [{ kind: "click", ref: "original-node" }] },
            "act",
          );
          if (state.pauseAfterApproval)
            await request.executeTool!(
              "ask_user",
              { question: "Which day?", options: ["Monday", "Tuesday"] },
              "choice",
            );
        }
        yield { type: "done" };
      },
    }),
  });
  cleanups.push(() => run.close());
  await run.prisma.actionApprovalRule.create({
    data: {
      spaceId: run.spaceId,
      createdByUserId: run.userId,
      effect: "require_approval",
      matchKind: "tool",
      matchValue: "browser_act",
    },
  });
  const id = await run.send("Submit after approval.");
  await run.continueRun(id);
  const paused = await run.prisma.run.findUniqueOrThrow({ where: { id } });
  expect(paused.error).toBeNull();
  expect(paused.status).toBe("waiting_input");
  const hold = browserApprovalCheckpointOf(paused.checkpoint);
  expect(hold).not.toBeNull();
  expect(effects).toBe(0);
  expect(releases).toEqual([]);
  const deps = { prisma: run.prisma, sandbox, events: run.events, jobs: new InMemoryJobQueue() };
  return {
    run,
    id,
    hold: hold!,
    checkpoint: paused.checkpoint!,
    deps,
    releases,
    state,
    effects: () => effects,
    async answer(answer: string) {
      const card = await latestCard(run.prisma, id);
      return run.events.answerRunInput({
        spaceId: run.spaceId,
        threadId: run.thread.id,
        runId: id,
        messageId: card.id,
        answeredByUserId: run.userId,
        answer,
      });
    },
    async expectReleased() {
      expect((await run.prisma.run.findUniqueOrThrow({ where: { id } })).checkpoint).toBeNull();
      if (hold!.lease)
        expect(
          (
            await run.prisma.computerExecutionLease.findFirstOrThrow({
              where: { computerId: hold!.computerId },
            })
          ).expiresAt.getTime(),
        ).toBeLessThan(Date.now());
      expect(
        [...sandbox.boxes.values()].flatMap((box) =>
          [...box.screens].filter(([key]) => key === `bot:${run.bot.id}`),
        ),
      ).toEqual([]);
    },
  };
}

it.each(["team", "dedicated"] as const)(
  "releases a %s screen on denial without opening the browser again",
  async (scope) => {
    const fixture = await pausedBrowser(scope);
    expect(await fixture.answer("deny")).toBe(true);
    await fixture.run.continueRun(fixture.id);
    expect(fixture.effects()).toBe(0);
    expect(fixture.releases).toHaveLength(1);
    expect(fixture.releases[0]!.screenLeaseId).not.toBe(fixture.hold.screenLeaseId);
    await fixture.expectReleased();
  },
);

it.each(["team", "dedicated"] as const)(
  "keeps %s setup retries recoverable and releases after terminal setup failure",
  async (scope) => {
    const fixture = await pausedBrowser(scope);
    expect(await fixture.answer("allow")).toBe(true);
    fixture.state.failSetup = true;
    for (let index = 0; index < 3; index++)
      await fixture.run.continueRun(fixture.id).catch(() => undefined);
    expect(
      await fixture.run.prisma.run.findUniqueOrThrow({ where: { id: fixture.id } }),
    ).toMatchObject({ status: "failed", checkpoint: null });
    expect(fixture.effects()).toBe(0);
    expect(fixture.releases).toHaveLength(1);
    await fixture.expectReleased();
  },
);

it.each(["team", "dedicated"] as const)(
  "recovers %s abandoned approval through cancellation and retains failed teardown",
  async (scope) => {
    const fixture = await pausedBrowser(scope);
    const expired = JSON.stringify({ ...fixture.hold, deadline: Date.now() - 1 });
    await fixture.run.prisma.run.update({
      where: { id: fixture.id },
      data: { checkpoint: expired },
    });
    fixture.state.failRelease = true;
    await recoverBrowserApprovalScreens(fixture.deps);
    expect(
      await fixture.run.prisma.run.findUniqueOrThrow({ where: { id: fixture.id } }),
    ).toMatchObject({ status: "cancelled", checkpoint: expired });
    expect(await fixture.answer("allow")).toBe(false);
    fixture.state.failRelease = false;
    await recoverBrowserApprovalScreens(fixture.deps);
    expect(fixture.effects()).toBe(0);
    await fixture.expectReleased();
  },
);

it.each([
  ["stop", "dedicated"],
  ["stop", "team"],
  ["clear", "dedicated"],
  ["rewind", "dedicated"],
] as const)("recovers captured coordinates after %s on %s", async (action, scope) => {
  const fixture = await pausedBrowser(scope);
  const { run, id } = fixture;
  if (action === "stop") {
    await stopThreadRuns(
      fixture.deps,
      { spaceId: run.spaceId, userId: run.userId },
      { kind: "bot", botId: run.bot.id, threadId: run.thread.id, bot: run.bot },
    );
  } else {
    const input = {
      spaceId: run.spaceId,
      threadId: run.thread.id,
      botId: run.bot.id,
      userId: run.userId,
    };
    if (action === "clear") await run.events.clearThread(input);
    else {
      const message = await run.prisma.sessionEntry.findFirstOrThrow({
        where: { session: { threadId: run.thread.id }, type: "user.message" },
      });
      await run.events.rewindThread({ ...input, messageId: message.id });
    }
    await recoverBrowserApprovalScreens(fixture.deps);
  }
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id } })).status).toBe("cancelled");
  expect(fixture.releases).toHaveLength(1);
  expect(fixture.releases[0]!.screenLeaseId).toBe(fixture.hold.screenLeaseId);
  await fixture.expectReleased();
});

it("refuses old-owner teardown after continuation claims and ignores expiry under a live run lease", async () => {
  const fixture = await pausedBrowser("team");
  expect(await fixture.answer("allow")).toBe(true);
  let checked = false;
  const find = fixture.run.prisma.attempt.count.bind(fixture.run.prisma.attempt);
  vi.spyOn(fixture.run.prisma.attempt, "count").mockImplementation(async (...args) => {
    const current = await fixture.run.prisma.run.findUniqueOrThrow({ where: { id: fixture.id } });
    expect(browserApprovalCheckpointOf(current.checkpoint)!.runFence).toBeGreaterThan(
      fixture.hold.runFence,
    );
    expect(await releaseBrowserApprovalScreen(fixture.deps, fixture.id, fixture.checkpoint)).toBe(
      false,
    );
    await fixture.run.prisma.run.update({
      where: { id: fixture.id },
      data: {
        checkpoint: JSON.stringify({
          ...browserApprovalCheckpointOf(current.checkpoint)!,
          deadline: Date.now() - 1,
        }),
      },
    });
    await recoverBrowserApprovalScreens(fixture.deps);
    expect(
      (await fixture.run.prisma.run.findUniqueOrThrow({ where: { id: fixture.id } })).status,
    ).toBe("running");
    expect(fixture.releases).toEqual([]);
    checked = true;
    return find(...args);
  });
  await fixture.run.continueRun(fixture.id);
  expect(checked).toBe(true);
  expect(fixture.effects()).toBe(1);
  await fixture.expectReleased();
});

it("retains a user-controlled screen until its control lease has ended", async () => {
  const fixture = await pausedBrowser("dedicated");
  await fixture.run.prisma.run.update({ where: { id: fixture.id }, data: { status: "cancelled" } });
  await fixture.run.prisma.computer.update({
    where: { id: fixture.hold.computerId },
    data: {
      controlHolder: "user",
      controlBotId: fixture.run.bot.id,
      controlLeaseId: "user-control",
      controlLeaseExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  await recoverBrowserApprovalScreens(fixture.deps);
  expect(fixture.releases).toEqual([]);
  await fixture.run.prisma.computer.update({
    where: { id: fixture.hold.computerId },
    data: { controlLeaseExpiresAt: new Date(0) },
  });
  await recoverBrowserApprovalScreens(fixture.deps);
  await fixture.expectReleased();
});

it("retires the browser checkpoint before a resumed choice overwrites it", async () => {
  const fixture = await pausedBrowser("dedicated");
  fixture.state.pauseAfterApproval = true;
  expect(await fixture.answer("allow")).toBe(true);
  await fixture.run.continueRun(fixture.id);
  const paused = await fixture.run.prisma.run.findUniqueOrThrow({ where: { id: fixture.id } });
  expect(paused.status).toBe("waiting_input");
  expect(JSON.parse(paused.checkpoint!).kind).toBe("choice_ask_v1");
  expect(fixture.releases).toHaveLength(1);
});

it("keeps the approval deadline when an already-started heartbeat arrives after pause", async () => {
  const fixture = await pausedBrowser("team");
  const lease = fixture.hold.lease!;
  // Recreate a heartbeat admitted just before the pause, delayed on its database request.
  await fixture.run.prisma.computerExecutionLease.updateMany({
    where: lease,
    data: { expiresAt: new Date(Date.now() + 60_000) },
  });
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const update = fixture.run.prisma.computerExecutionLease.updateMany.bind(
    fixture.run.prisma.computerExecutionLease,
  );
  const delayed = vi
    .spyOn(fixture.run.prisma.computerExecutionLease, "updateMany")
    .mockImplementationOnce(async (...args) => {
      entered.resolve();
      await resume.promise;
      return update(...args);
    });
  const heartbeat = renewComputerExecutionLease(fixture.run.prisma, lease);
  await entered.promise;
  await update({ where: lease, data: { expiresAt: new Date(fixture.hold.deadline) } });
  resume.resolve();
  expect(await heartbeat).toBe(true);
  delayed.mockRestore();
  const retained = await fixture.run.prisma.computerExecutionLease.findFirstOrThrow({
    where: lease,
  });
  expect(retained.expiresAt.getTime()).toBe(fixture.hold.deadline);
  expect(
    await renewComputerExecutionLease(fixture.run.prisma, { ...lease, fence: lease.fence + 1 }),
  ).toBe(false);
  expect(
    await renewComputerExecutionLease(fixture.run.prisma, { ...lease, runId: "superseded-run" }),
  ).toBe(false);
  await update({ where: lease, data: { expiresAt: new Date(0) } });
  expect(await renewComputerExecutionLease(fixture.run.prisma, lease)).toBe(false);
  expect(
    (await fixture.run.prisma.computerExecutionLease.findFirstOrThrow({ where: lease })).expiresAt,
  ).toEqual(new Date(0));
});

it.skipIf(process.env.VERIFY_DOCKER_TEAM_SCREENS !== "1")(
  "Stop kills pre-approval background work during an active continuation",
  async () => {
    const machine = await dockerE2BMachine(
      process.env.COMPUTER_TEST_IMAGE ?? "rakazo/computer:local",
    );
    cleanups.push(() => machine.close());
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const fixture = await pausedBrowser("team", {
      beforeApproval: async (_computer, context, computerId) => {
        const argv = [
          "bash",
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "launch",
          computerId,
          context.runId!,
          "test",
          "echo $$ >/tmp/approval-background.pid; exec sleep 300",
        ];
        expect(
          (
            await machine.exec(
              `${argv.map(quote).join(" ")} >/tmp/approval-background.log 2>&1 </dev/null &`,
            )
          ).exitCode,
        ).toBe(0);
      },
      execute: async function* (_computer, request) {
        const result = await machine.exec(request.argv.map(quote).join(" "));
        yield { type: "exit", code: result.exitCode };
      },
      resumed: async () => {
        entered.resolve();
        await resume.promise;
      },
    });
    expect(await fixture.answer("allow")).toBe(true);
    const continuation = fixture.run.continueRun(fixture.id);
    await entered.promise;
    try {
      expect((await machine.exec("kill -0 $(cat /tmp/approval-background.pid)")).exitCode).toBe(0);
      await stopThreadRuns(
        fixture.deps,
        { spaceId: fixture.run.spaceId, userId: fixture.run.userId },
        {
          kind: "bot",
          botId: fixture.run.bot.id,
          threadId: fixture.run.thread.id,
          bot: fixture.run.bot,
        },
      );
      expect(
        (
          await machine.exec(
            "test ! -d /proc/$(cat /tmp/approval-background.pid) || test \"$(awk '{print $3}' /proc/$(cat /tmp/approval-background.pid)/stat)\" = Z",
          )
        ).exitCode,
      ).toBe(0);
    } finally {
      resume.resolve();
      await continuation;
    }
    await fixture.expectReleased();
  },
);

it("recovers only the captured computer in bounded pages after its bot changes computers", async () => {
  const fixture = await pausedBrowser("dedicated");
  const { prisma } = fixture.run;
  const original = await prisma.run.findUniqueOrThrow({ where: { id: fixture.id } });
  await prisma.bot.update({ where: { id: fixture.run.bot.id }, data: { computerId: null } });
  await prisma.run.update({ where: { id: fixture.id }, data: { status: "cancelled" } });
  const unrelated = JSON.stringify({
    ...fixture.hold,
    computerId: 'other"\\computer',
    effectId: fixture.hold.computerId,
  });
  const rows = Array.from({ length: 121 }, (_, index) => ({
    ...original,
    id: `recovery-${String(index).padStart(3, "0")}`,
    status: "cancelled",
    checkpoint: index < 61 ? fixture.checkpoint : unrelated,
  }));
  await prisma.run.createMany({ data: rows });
  await prisma.run.create({
    data: {
      ...original,
      id: "malformed-checkpoint",
      status: "cancelled",
      checkpoint: '{"kind":"browser_approval_v1",broken',
    },
  });
  const fetched: Array<{ id: string; checkpoint: string | null }> = [];
  const find = prisma.run.findMany.bind(prisma.run);
  vi.spyOn(prisma.run, "findMany").mockImplementation(async (...args) => {
    const page = await find(...args);
    expect(page.length).toBeLessThanOrEqual(50);
    fetched.push(...page);
    return page;
  });
  await recoverBrowserApprovalScreens(fixture.deps, { computerId: fixture.hold.computerId });
  expect(fetched).toHaveLength(62);
  expect(
    fetched.every(
      (run) => browserApprovalCheckpointOf(run.checkpoint)?.computerId === fixture.hold.computerId,
    ),
  ).toBe(true);
  expect(
    await prisma.run.count({ where: { id: { startsWith: "recovery-" }, checkpoint: null } }),
  ).toBe(61);
  expect(await prisma.run.count({ where: { checkpoint: unrelated } })).toBe(60);
  expect(fixture.releases).toHaveLength(62);
  await fixture.expectReleased();
});

it.skipIf(process.env.VERIFY_DATABASE !== "1" || !process.env.DATABASE_URL)(
  "serializes group approval teardown with a personal-thread user grant on the same computer",
  async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const fixture = await pausedBrowser("team", {
      databaseUrl: process.env.DATABASE_URL,
      releasing: async () => {
        entered.resolve();
        await finish.promise;
      },
    });
    const { prisma } = fixture.run;
    const group = await prisma.chatGroup.create({
      data: {
        spaceId: fixture.run.spaceId,
        userId: fixture.run.userId,
        name: "Approval team",
      },
    });
    const thread = await prisma.thread.create({
      data: {
        spaceId: fixture.run.spaceId,
        userId: fixture.run.userId,
        groupId: group.id,
      },
    });
    await prisma.run.update({
      where: { id: fixture.id },
      data: { threadId: thread.id, status: "cancelled" },
    });
    await prisma.computerExecutionLease.updateMany({
      where: fixture.hold.lease!,
      data: { expiresAt: new Date(0) },
    });
    const router = createRouter({
      ...fixture.deps,
      env: { sandboxProvider: "fake" },
    } as unknown as RouterDeps);
    const release = recoverBrowserApprovalScreens(fixture.deps, { runIds: [fixture.id] });
    await entered.promise;
    let granted = false;
    const procedure = router.computer.takeover;
    const grant = Promise.resolve(
      procedure["~orpc"].handler({
        context: {
          actor: {
            spaceId: fixture.run.spaceId,
            userId: fixture.run.userId,
            email: "worker@rakazo.test",
            isDeploymentOwner: true,
          },
        },
        input: { botId: fixture.run.bot.id },
        path: ["computer", "takeover"],
        procedure,
        lastEventId: undefined,
        errors: {},
      }),
    ).then((result) => {
      granted = true;
      return result;
    });
    void grant.catch(() => undefined);
    try {
      await expect
        .poll(
          async () => {
            if (granted) return "granted before teardown";
            const blocked = await prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query LIKE '%UPDATE%computers%'`;
            return Number(blocked[0]!.count) > 0 ? "waiting for teardown" : "not yet waiting";
          },
          { timeout: 2_000, interval: 20 },
        )
        .toBe("waiting for teardown");
    } finally {
      finish.resolve();
      await release;
    }
    const result = await grant;
    expect(result.leaseId).toEqual(expect.any(String));
    expect(
      await prisma.computer.findUniqueOrThrow({ where: { id: fixture.hold.computerId } }),
    ).toMatchObject({ controlHolder: "user", controlBotId: fixture.run.bot.id });
    expect(fixture.releases).toHaveLength(1);
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: fixture.id } })).checkpoint,
    ).toBeNull();
  },
);
