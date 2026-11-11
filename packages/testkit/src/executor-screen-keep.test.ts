import type { AdapterContext, ComputerRef, PageBrowserCommand } from "@tangow/adapter-kit";
import { E2BSandboxEmulator } from "@tangow/adapters";
import { afterEach, expect, it, vi } from "vitest";
import { stopThreadRuns } from "../../../apps/api/src/thread-target.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function runEndingWith(end: "completes" | "asks" | "fails" | "is stopped") {
  const releases: Array<string | undefined> = [];
  const signalAborted: boolean[] = [];
  class Computer extends E2BSandboxEmulator {
    async pageBrowser(
      computer: ComputerRef,
      _request: PageBrowserCommand,
      context: AdapterContext,
    ) {
      await this.connectScreen(computer, {}, context);
      return {
        ok: true,
        url: "https://example.test/",
        title: "Example",
        elements: [],
        tree: "(no interactive elements)",
        completed: 1,
      };
    }
    override async releaseScreen(
      computer: ComputerRef,
      context: AdapterContext,
      release?: "keep" | "teardown",
    ) {
      releases.push(release);
      signalAborted.push(context.signal.aborted);
      await super.releaseScreen(computer, context);
    }
  }
  const run = await startWorkerRun({
    steps: [],
    computerScope: "dedicated",
    sandbox: new Computer(),
    runtime: () => ({
      describe: () => ({
        id: "fixture",
        contractVersion: "1",
        adapterVersion: "0",
        capabilities: { scripted: false, streaming: false },
      }),
      abort: async () => {},
      async *run(request) {
        await request.executeTool!("browser_snapshot", {}, "snapshot");
        if (end === "fails") throw new Error("Synthetic runtime failure");
        if (end === "asks")
          await request.executeTool!(
            "ask_user",
            { question: "Which day?", options: ["Monday", "Tuesday"] },
            "choice",
          );
        if (end === "is stopped")
          await stopThreadRuns(
            run,
            { spaceId: run.spaceId, userId: run.userId },
            { kind: "bot", botId: run.bot.id, threadId: run.thread.id, bot: run.bot },
          );
        yield { type: "done" };
      },
    }),
  });
  cleanups.push(() => run.close());
  const id = await run.send("Open the page.");
  await run.continueRun(id).catch(() => undefined);
  const status = (await run.prisma.run.findUniqueOrThrow({ where: { id } })).status;
  return { releases, status, signalAborted };
}

it("keeps the screen when a run completes", async () => {
  const { releases, status } = await runEndingWith("completes");
  expect({ releases, status }).toEqual({ releases: ["keep"], status: "completed" });
});

it("keeps the screen when a run waits for an answer, though its signal is aborted by then", async () => {
  const { releases, status, signalAborted } = await runEndingWith("asks");
  expect({ releases, status, signalAborted }).toEqual({
    releases: ["keep"],
    status: "waiting_input",
    signalAborted: [true],
  });
});

it("tears the screen down when a run fails", async () => {
  const { releases, status } = await runEndingWith("fails");
  expect({ releases, status }).toEqual({ releases: [undefined], status: "failed" });
});

it("tears the screen down when a run is stopped", async () => {
  const { releases, status } = await runEndingWith("is stopped");
  expect({ releases, status }).toEqual({ releases: [undefined], status: "cancelled" });
});
