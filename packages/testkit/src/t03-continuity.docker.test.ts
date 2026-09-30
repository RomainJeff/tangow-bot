import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntimeEvent,
  ComputerRef,
  Continuity,
  NativeProcess,
} from "@rakazo/adapter-kit";
import { CodexNativeRuntime, DockerSandboxProvider } from "@rakazo/adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sandboxCommandOutput } from "./cli/t01-live-subscription.ts";

const enabled = process.env.RUN_T03_DOCKER === "1";
const codexAuthEnabled = enabled && process.env.RUN_T03_CODEX_AUTH === "1";

async function command(
  sandbox: DockerSandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  argv: string[],
) {
  const events = [];
  for await (const event of sandbox.execute(
    computer,
    { argv, cwd: ".", timeoutMs: 5_000 },
    context,
  ))
    events.push(event);
  return events;
}

function stdout(events: Awaited<ReturnType<typeof command>>): string {
  return events
    .filter((event) => event.type === "stdout")
    .map((event) => event.data)
    .join("");
}

function redactNativeError(value: unknown): string {
  return String(value ?? "unknown")
    .replace(/eyJ[A-Za-z0-9._-]*/g, "<jwt>")
    .replace(/token[\s\S]*/gi, "token<redacted>")
    .replace(/accountId(?:["']?\s*[:=]\s*["']?|\s+)[^,\s}"']+/gi, "accountId<redacted>")
    .replace(/postgres:\/\/\S+/gi, "<postgres-url>")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

async function nativeRpc(
  process: NativeProcess,
  lines: AsyncIterator<string>,
  id: number,
  method: string,
  params: Record<string, unknown>,
) {
  await process.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  for (;;) {
    const line = await lines.next();
    if (line.done) {
      const terminal = await process.wait();
      throw new Error(
        `native process ended before ${method} (exit ${terminal.code ?? "unknown"}, stderr ${terminal.stderr?.category ?? "none"})`,
      );
    }
    const message = JSON.parse(line.value) as {
      id?: unknown;
      result?: { thread?: { id?: unknown } };
      error?: { code?: unknown; message?: unknown };
    };
    if (message.id === id) return message;
  }
}

async function waitForFile(
  sandbox: DockerSandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  file: string,
): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await sandbox
      .readFile(computer, file, context)
      .then((data) => new TextDecoder().decode(data))
      .catch(() => undefined);
    if (value) return value.trim();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${file}`);
}

function nativeRequest(runId: string, continuity: Continuity): AgentRunRequest {
  return {
    botId: "t03-runtime",
    threadId: "t03-thread",
    runId,
    prompt: "T03 Docker continuity probe",
    instructions: "",
    history: [],
    tools: [],
    model: {
      provider: "openai-codex",
      id: "gpt-5.6-terra",
      // This is intentionally not a credential. The real image must either
      // reject it without OAuth or complete the real app-server exchange.
      oauth: {
        credential: {
          type: "oauth",
          access: "t03-not-a-real-access-token",
          refresh: "t03-not-a-real-refresh-token",
          expires: 0,
          accountId: "t03-no-auth",
        },
      },
    },
    execution: {
      choice: { harness: "codex-native", targetId: "t03-computer" },
      authority: { runId, attemptId: `${runId}-attempt`, fence: 1, policyRevision: 1 },
      continuity,
      computerId: "t03-computer",
      contextRevision: 0,
    },
  };
}

type Campaign = {
  root: string;
  context: AdapterContext;
  supervisor: ReturnType<typeof serve>;
  sandbox: DockerSandboxProvider;
  computer: ComputerRef;
};

describe.skipIf(!enabled).sequential("T03 real Docker continuity", () => {
  let campaign: Campaign | undefined;

  beforeAll(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-t03-continuity-"));
    const token = `t03-${randomUUID()}`;
    const context: AdapterContext = {
      operationId: "t03-docker",
      traceId: "t03-docker",
      spaceId: "t03-space",
      userId: "t03-user",
      botId: "t03-runtime",
      signal: AbortSignal.timeout(90_000),
    };
    let supervisor: ReturnType<typeof serve> | undefined;
    try {
      process.env.DATA_DIR = path.join(root, "data");
      process.env.RAKAZO_COMPUTER_IMAGE = "rakazo-t01-terra/computer-codex-0.154.0:local";
      process.env.SANDBOX_SUPERVISOR_TOKEN = token;
      process.env.SANDBOX_PROVIDER = "docker";
      const { supervisorApp } = await import("../../../infra/sandboxes/supervisor/src/index.ts");
      supervisor = serve({ fetch: supervisorApp.fetch, hostname: "127.0.0.1", port: 0 });
      if (!supervisor.listening)
        await new Promise<void>((resolve, reject) => {
          supervisor.once("error", reject);
          supervisor.once("listening", resolve);
        });
      const supervisorUrl = `http://127.0.0.1:${(supervisor.address() as AddressInfo).port}`;
      const sandbox = new DockerSandboxProvider(supervisorUrl, token);
      const computer = await sandbox.provision(
        { botId: context.botId!, homePath: path.join(root, "data", "homes", context.botId!) },
        context,
      );
      await sandbox.writeFile(computer, { path: "t03/.keep", content: new Uint8Array() }, context);
      campaign = { root, context, supervisor, sandbox, computer };
    } catch (error) {
      await new Promise<void>((resolve) => supervisor?.close(() => resolve()) ?? resolve());
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }, 30_000);

  afterAll(async () => {
    if (!campaign) return;
    const active = campaign;
    await active.sandbox.destroy(active.computer, active.context).catch(() => undefined);
    await new Promise<void>((resolve) => active.supervisor.close(() => resolve()));
    await rm(active.root, { recursive: true, force: true }).catch(() => undefined);
  });

  it("stops a real TERM-resistant process, proves its group empty, and reconfirms another KILLed session", async () => {
    const { sandbox, computer, context } = campaign!;
    const stubborn = await sandbox.startNativeProcess!(
      computer,
      {
        argv: [
          "sh",
          "-c",
          'pgid=$(ps -o pgid= -p $$ | tr -d " "); printf %s "$pgid" > t03-stubborn.pgid; trap "" TERM; while :; do sleep 1; done',
        ],
        cwd: "t03",
      },
      context,
    );
    const pgid = await waitForFile(sandbox, computer, context, "t03/t03-stubborn.pgid");
    const killedStatus = await stubborn.stop();
    const killedTerminal = await stubborn.wait();
    expect(killedStatus).toBe("stopped");
    // SIGKILL cannot write the wrapper's .exit record. Confirmation instead
    // comes from the bounded process-group probe in the supervisor.
    expect(killedTerminal).toMatchObject({
      code: null,
      exitSource: "unknown_after_kill",
    });
    const emptyGroup = await command(sandbox, computer, context, [
      "sh",
      "-c",
      'pgid="$1"; test -n "$pgid" && ! ps -eo pgid= | tr -d " " | grep -qx "$pgid"',
      "sh",
      pgid,
    ]);
    expect(emptyGroup.at(-1)).toEqual({ type: "exit", code: 0 });

    const reconfirmable = await sandbox.startNativeProcess!(
      computer,
      {
        argv: [
          "sh",
          "-c",
          'pgid=$(ps -o pgid= -p $$ | tr -d " "); printf %s "$pgid" > t03-reconfirm.pgid; trap "" TERM; while :; do sleep 1; done',
        ],
        cwd: "t03",
      },
      context,
    );
    const reconfirmPgid = await waitForFile(sandbox, computer, context, "t03/t03-reconfirm.pgid");
    const manualKill = await command(sandbox, computer, context, [
      "sh",
      "-c",
      'kill -KILL -"$1"',
      "sh",
      reconfirmPgid,
    ]);
    expect(manualKill.at(-1)).toEqual({ type: "exit", code: 0 });
    await expect(
      sandbox.reconfirmNativeProcess!(computer, reconfirmable.id!, context),
    ).resolves.toBe("stopped");
    await expect(
      sandbox.reconfirmNativeProcess!(computer, reconfirmable.id!, context),
    ).resolves.toBe("stopped");
    await expect(reconfirmable.stop()).resolves.toBe("stopped");
    await expect(reconfirmable.wait()).resolves.toMatchObject({
      code: null,
      exitSource: "unknown_after_kill",
    });
  }, 30_000);

  it("runs the J2 PID probe after its original turn deadline has expired", async () => {
    const { sandbox, computer, context } = campaign!;
    const native = await sandbox.startNativeProcess!(
      computer,
      { argv: ["sh", "-c", "while :; do sleep 1; done"], cwd: "t03" },
      context,
    );
    const expiredContext = { ...context, signal: AbortSignal.timeout(1) };
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      await expect(
        sandboxCommandOutput(
          sandbox,
          computer,
          [
            "sh",
            "-c",
            "ps -eo pid=,args= | awk '/[c]odex app-server --listen stdio:\\/\\// {print $1}'",
          ],
          expiredContext,
        ),
      ).resolves.toMatchObject({ code: 0 });
    } finally {
      await native.stop();
    }
  }, 30_000);

  it("proves whether a fresh app-server can start and resume without login", async () => {
    const { sandbox, computer, context } = campaign!;
    const homeA =
      "/tmp/rakazo-codex-t03-runtime-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const homeB =
      "/tmp/rakazo-codex-t03-runtime-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const start = (home: string) =>
      sandbox.startNativeProcess!(
        computer,
        {
          argv: [
            "sh",
            "-c",
            "pwd > .t03-native-cwd; id -u > .t03-native-uid; exec codex app-server --listen stdio://",
          ],
          cwd: "t03",
          privateHome: home,
          env: { CI: "1", OPENAI_API_KEY: "", CODEX_HOME: home },
        },
        context,
      );
    const first = await start(homeA);
    try {
      const firstLines = first.stdout[Symbol.asyncIterator]();
      const initialized = await nativeRpc(first, firstLines, 1, "initialize", {
        clientInfo: { name: "rakazo-t03", version: "test" },
        capabilities: { experimentalApi: true },
      });
      expect(initialized.error).toBeUndefined();
      await expect(
        sandbox
          .readFile(computer, "t03/.t03-native-cwd", context)
          .then((data) => new TextDecoder().decode(data)),
      ).resolves.toBe("/home/rakazo/t03\n");
      await expect(
        sandbox
          .readFile(computer, "t03/.t03-native-uid", context)
          .then((data) => new TextDecoder().decode(data)),
      ).resolves.toBe("1000\n");
      await first.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`,
      );
      const created = await nativeRpc(first, firstLines, 2, "thread/start", {});
      if (created.error) {
        console.info(`T03_NO_AUTH_THREAD_START=${redactNativeError(created.error.message)}`);
        expect(String(created.error.message)).toMatch(/auth|login|sign.?in|account/i);
        return;
      }
      const threadId = created.result?.thread?.id;
      expect(typeof threadId).toBe("string");
      expect(
        (
          await command(sandbox, computer, context, [
            "sh",
            "-c",
            'test "$(stat -c "%a:%u:%g" "$1")" = 700:1000:1000 && test "${1#/home/rakazo/}" = "$1"',
            "sh",
            homeA,
          ])
        ).at(-1),
      ).toEqual({ type: "exit", code: 0 });
      console.info("T03_HOME_MODE=700");
      await expect(first.stop()).resolves.toBe("stopped");
      const resumed = await start(homeA);
      try {
        const resumedLines = resumed.stdout[Symbol.asyncIterator]();
        expect(
          (
            await nativeRpc(resumed, resumedLines, 1, "initialize", {
              clientInfo: { name: "rakazo-t03", version: "test" },
              capabilities: { experimentalApi: true },
            })
          ).error,
        ).toBeUndefined();
        await resumed.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`,
        );
        const noRollout = await nativeRpc(resumed, resumedLines, 2, "thread/resume", { threadId });
        expect(noRollout.error).toMatchObject({ code: -32600 });
        console.info(`T03_NO_AUTH_SAME_HOME_RESUME=${redactNativeError(noRollout.error?.message)}`);
      } finally {
        await resumed.stop().catch(() => undefined);
      }
      const fresh = await start(homeB);
      try {
        const freshLines = fresh.stdout[Symbol.asyncIterator]();
        expect(
          (
            await nativeRpc(fresh, freshLines, 1, "initialize", {
              clientInfo: { name: "rakazo-t03", version: "test" },
              capabilities: { experimentalApi: true },
            })
          ).error,
        ).toBeUndefined();
        await fresh.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`,
        );
        const rejected = await nativeRpc(fresh, freshLines, 2, "thread/resume", { threadId });
        expect(rejected.error).toMatchObject({ code: -32600 });
        console.info(`T03_FRESH_HOME_RESUME=${redactNativeError(rejected.error?.message)}`);
      } finally {
        await fresh.stop().catch(() => undefined);
      }
    } finally {
      await first.stop().catch(() => undefined);
    }
  }, 60_000);

  it.skipIf(!codexAuthEnabled)(
    "reconstructs through thread/resume with an authenticated Codex image (requires RUN_T03_CODEX_AUTH=1)",
    async () => {
      const { sandbox, computer, context } = campaign!;
      let started: NativeProcess | undefined;
      const nativeWrites: string[][] = [];
      const runtimeSandbox = Object.create(sandbox) as DockerSandboxProvider;
      runtimeSandbox.startNativeProcess = async (...args) => {
        const process = await sandbox.startNativeProcess!(...args);
        started ??= process;
        const writes: string[] = [];
        nativeWrites.push(writes);
        return {
          ...process,
          write: async (data) => {
            writes.push(data);
            await process.write(data);
          },
        };
      };
      const runtime = new CodexNativeRuntime({ sandbox: runtimeSandbox, computer, cwd: "t03" });
      const firstEvents: AgentRuntimeEvent[] = [];
      try {
        for await (const event of runtime.run(
          nativeRequest("t03-runtime-first", {
            mode: "new",
            ref: { bindingId: "t03-runtime", generation: 0 },
          }),
          context,
        ))
          firstEvents.push(event);
        const nativeRef = firstEvents.find(
          (event): event is Extract<AgentRuntimeEvent, { type: "native" }> =>
            event.type === "native" && event.event.type === "reference",
        )?.event.nativeRef;
        expect(nativeRef).toBeTruthy();
        const oldPid = stdout(
          await command(sandbox, computer, context, [
            "sh",
            "-c",
            "ps -eo pid=,args= | awk '/[c]odex app-server/ {print $1; exit}'",
          ]),
        ).trim();
        expect(oldPid).toMatch(/^\d+$/);
        // The explicit reconstruction input is the worker-loss seam: the old
        // parked process is stopped first, so only Codex's durable thread may be
        // resumed by the successor process.
        await expect(started!.stop()).resolves.toBe("stopped");
        const oldPidGone = await command(sandbox, computer, context, [
          "sh",
          "-c",
          'test ! -d "/proc/$1"',
          "sh",
          oldPid,
        ]);
        expect(oldPidGone.at(-1)).toEqual({ type: "exit", code: 0 });
        const reconstructedRuntime = new CodexNativeRuntime({
          sandbox: runtimeSandbox,
          computer,
          cwd: "t03",
        });
        const reconstructed: AgentRuntimeEvent[] = [];
        for await (const event of reconstructedRuntime.run(
          nativeRequest("t03-runtime-reconstruct", {
            mode: "reconstruct",
            previous: { bindingId: "t03-runtime", generation: 0 },
            reason: "test_worker_lost",
            inputId: "t03-reconstruct",
            nativeRef,
          }),
          context,
        ))
          reconstructed.push(event);
        expect(reconstructed).toContainEqual(
          expect.objectContaining({
            type: "native",
            event: expect.objectContaining({ type: "session", continuity: "reconstructed" }),
          }),
        );
        expect(nativeWrites[1]?.map((write) => JSON.parse(write).method)).toContain(
          "thread/resume",
        );
        await reconstructedRuntime.abort("t03-runtime-reconstruct");
      } finally {
        await runtime.abort("t03-runtime-first").catch(() => undefined);
      }
    },
    90_000,
  );
});
