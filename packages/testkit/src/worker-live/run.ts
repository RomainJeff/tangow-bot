import type { ConnectorProvider, SandboxProvider, WorkerProvider } from "@rakazo/adapter-kit";
import type { GuestConnector } from "@rakazo/adapters/runtime-worker";
import { volumeMountPath } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "../model-emulator.js";
import type { Seen } from "../worker-channel-tap.js";
import { parse, tapConnector } from "../worker-channel-tap.js";
import { startWorkerRun } from "../worker-run-fixture.js";
import type { Live, ProviderWrap } from "./session.js";

/**
 * The real executor on PGlite with the product's worker routing: a run's tools decide what it
 * mounts, and its bot's E2B worker runs it, with the model emulator behind the controller's relay.
 * A dedicated computer's bot mounts its private volume, a team computer's bot also the space's
 * shared one, and a bot without a computer mounts nothing.
 */
export async function liveRun(
  live: Live,
  options: {
    steps: ModelEmulatorStep[];
    databaseUrl?: string;
    /** The model's wire protocol: a custom OpenAI-compatible connection, or Anthropic's catalog. */
    protocol?: "openai" | "anthropic";
    computer?: "dedicated" | "team" | "none";
    /** MCP and integration tools, served by the controller. */
    tools?: ConnectorProvider;
    /** Runs the guest on another provider than the session's E2B one. */
    provider?: () => WorkerProvider & GuestConnector;
    wrap?: ProviderWrap;
    /** The bot's computer instead of the fake one, such as the product's E2B computer. */
    sandbox?: SandboxProvider;
    prisma?: (prisma: PrismaClient) => PrismaClient;
  },
) {
  const seen: Seen[] = [];
  const connects: number[] = [];
  const run = await startWorkerRun({
    steps: options.steps.map((step) => ({
      ...step,
      response(request) {
        const reply = typeof step.response === "function" ? step.response(request) : step.response;
        if (reply.type !== "tool") return reply;
        const assigned = request.tools?.find(
          (tool) => tool.function.name === `mcp__rakazo__${reply.name}`,
        );
        return assigned ? { ...reply, name: assigned.function.name } : reply;
      },
    })),
    screensByPath: live.config.harness !== "pi",
    databaseUrl: options.databaseUrl,
    protocol: options.protocol,
    tools: options.tools,
    prisma: options.prisma,
    computerScope: options.computer ?? "dedicated",
    sandbox: options.sandbox,
    provider: () => {
      const base = options.provider?.() ?? live.workerProvider();
      return options.wrap?.(base) ?? base;
    },
    connector: (provider) => tapConnector(provider, seen, connects),
  });
  const rows = await run.prisma.volume.findMany({ select: { kind: true, providerRef: true } });
  const volumes = {
    private: rows.find((row) => row.kind === "bot_private")?.providerRef ?? undefined,
    shared: rows.find((row) => row.kind === "space_shared")?.providerRef ?? undefined,
  };
  const workers = run.lifecycle;
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
  (request.tools ?? []).map((tool) => tool.function.name.replace(/^mcp__rakazo__/, ""));
