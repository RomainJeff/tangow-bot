import type { AdapterContext, ComputerRef, PageBrowserCommand } from "@rakazo/adapter-kit";
import {
  InMemoryJobQueue,
  ManagedSandboxEmulator,
  PiAgentRuntime,
  recoverBrowserApprovalScreens,
} from "@rakazo/adapters";
import { browserApprovalCheckpointOf } from "@rakazo/db";
import { afterEach, expect, it, vi } from "vitest";
import { stopThreadRuns } from "../../../apps/api/src/thread-target.js";
import { releaseBrowserApprovalScreen } from "../../adapters/src/browser-approval.js";
import { latestCard } from "./index.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function pausedBrowser(scope: "team" | "dedicated") {
  let effects = 0;
  const releases: AdapterContext[] = [];
  const state = { failSetup: false, failRelease: false, pauseAfterApproval: false };
  class Computer extends ManagedSandboxEmulator {
    async pageBrowser(computer: ComputerRef, request: PageBrowserCommand, context: AdapterContext) {
      await this.connectScreen(computer, {}, context);
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
      if (state.failRelease) throw new Error("Synthetic release failure");
      await super.releaseScreen(computer, context);
    }
  }
  const sandbox = new Computer();
  let calls = 0;
  const run = await startWorkerRun({
    steps: [],
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
        ...new PiAgentRuntime().describe(),
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
