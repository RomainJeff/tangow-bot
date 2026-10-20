import type { WorkerProvider } from "@rakazo/adapter-kit";
import { createWorkerLifecycle, type WorkerLifecycle } from "@rakazo/adapters";
import {
  createLifecycleLauncher,
  createStopJournal,
  createWorkerAgentRuntime,
  type GuestConnector,
} from "@rakazo/adapters/runtime-worker";
import { type RunNeeds, volumeMountPath } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "../model-emulator.js";
import { parse, type Seen, tapConnector } from "../worker-channel-tap.js";
import { startWorkerRun } from "../worker-run-fixture.js";

import { context, type Live, type ProviderWrap } from "./session.js";

/**
 * The real executor on PGlite, running its bot in an E2B worker through the worker runtime, with
 * the model emulator behind the controller's relay. With `files`, the bot's home is on volumes
 * the lifecycle provisions on E2B, and the run mounts them.
 */
export async function liveRun(
  live: Live,
  options: {
    steps: ModelEmulatorStep[];
    files?: { private: boolean; shared: boolean };
    /** Runs the guest on another provider than the session's E2B one. */
    provider?: () => WorkerProvider & GuestConnector;
    wrap?: ProviderWrap;
    prisma?: (prisma: PrismaClient) => PrismaClient;
  },
) {
  const seen: Seen[] = [];
  const connects: number[] = [];
  const files = options.files ?? { private: false, shared: false };
  const needs: RunNeeds = {
    files: { private: files.private ? "rw" : null, shared: files.shared ? "rw" : null },
    computer: "none",
  };
  let lifecycle: WorkerLifecycle | undefined;
  const run = await startWorkerRun({
    steps: options.steps,
    prisma: options.prisma,
    runtime: (prisma) => {
      const base = options.provider?.() ?? live.workerProvider();
      const provider = options.wrap?.(base) ?? base;
      lifecycle = createWorkerLifecycle({ prisma, provider });
      return createWorkerAgentRuntime({
        launcher: createLifecycleLauncher({
          prisma,
          lifecycle,
          connector: tapConnector(provider, seen, connects),
          needs,
        }),
        stops: createStopJournal(prisma),
      });
    },
  });
  const workers = lifecycle!;
  const volumes: { private?: string; shared?: string } = {};
  if (files.private || files.shared) {
    await run.homeOnVolumes();
    if (files.private) {
      volumes.private = (
        await workers.ensureVolume(
          { kind: "bot_private", spaceId: run.spaceId, botId: run.bot.id },
          context("private"),
        )
      ).providerRef;
    }
    if (files.shared) {
      volumes.shared = (
        await workers.ensureVolume(
          { kind: "space_shared", spaceId: run.spaceId },
          context("shared"),
        )
      ).providerRef;
    }
  }
  const privateMount = volumeMountPath({ kind: "bot_private", botId: run.bot.id });
  const sharedMount = volumeMountPath({ kind: "space_shared" });
  return {
    run,
    seen,
    connects,
    lifecycle: workers,
    volumes,
    privateMount,
    sharedMount,
    /** The volumes as a computer mounts them, at the same paths. */
    mounts(): Record<string, string> {
      return {
        ...(volumes.private && { [privateMount]: volumes.private }),
        ...(volumes.shared && { [sharedMount]: volumes.shared }),
      };
    },
    async send(text: string) {
      const runId = await run.send(text);
      await run.continueRun(runId);
      return runId;
    },
    async status(runId: string) {
      return (await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status;
    },
    /** Throws with what the controller saw unless the run completed and used every model step. */
    async completed(runId: string) {
      const row = await run.prisma.run.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, error: true },
      });
      if (row.status !== "completed") {
        const attempts = await run.prisma.attempt.findMany({
          where: { runId },
          select: { status: true, workerState: true, stopPhase: true, error: true },
        });
        const frames = parse(seen).map((frame) => `${frame.from}:${frame.type ?? frame.kind}`);
        throw new Error(
          `The run ended ${row.status}: ${row.error ?? ""}; attempts ${JSON.stringify(attempts)}; frames ${frames.join(" ")}`,
        );
      }
      run.model.assertComplete();
    },
    async attempts(runId: string) {
      return run.prisma.attempt.findMany({
        where: { runId },
        select: { workerState: true, stopPhase: true, workerProviderRef: true },
        orderBy: { fence: "asc" },
      });
    },
    async results(runId: string) {
      return (await run.runEntries(runId)).flatMap((entry) =>
        entry.type === "tool.result" ? [[entry.payload.output, entry.payload.isError]] : [],
      );
    },
    /** The frames the controller read and sent, by kind and body type. */
    frames: () => parse(seen),
    close: () => run.close(),
  };
}

export const recap = (what: string) =>
  JSON.stringify({ version: 1, results: [what], references: [] });
export const call = (
  id: string,
  name: string,
  args: Record<string, unknown>,
  expect: ModelEmulatorStep["expect"] = () => {},
): ModelEmulatorStep => ({
  expect,
  response: { type: "tool", id, name, arguments: args },
});
export const finish = (
  what: string,
  expect: ModelEmulatorStep["expect"] = () => {},
): ModelEmulatorStep[] => [
  call("say", "message_user", { message: "Done." }, expect),
  { expect() {}, response: { type: "text", text: recap(what) } },
];
export const toolNames = (request: ModelEmulatorRequest) =>
  (request.tools ?? []).map((tool) => tool.function.name);
