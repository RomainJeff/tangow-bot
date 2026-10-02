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

const enabled = process.env.RUN_NATIVE_CONTINUITY_DOCKER === "1";
const codexAuthEnabled = enabled && process.env.RUN_NATIVE_CONTINUITY_CODEX_AUTH === "1";

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

/** Runs a command under its own deadline, whatever state the caller's signal is in. */
async function commandOutput(
  sandbox: DockerSandboxProvider,
  computer: ComputerRef,
  argv: string[],
  context: AdapterContext,
  timeoutMs = 10_000,
): Promise<{ code: number; stdout: string }> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Computer command timed out.")),
    timeoutMs,
  );
  try {
    let output = "";
    let code: number | undefined;
    for await (const event of sandbox.execute(
      computer,
      { argv, cwd: "", timeoutMs },
      { ...context, signal: controller.signal },
    )) {
      if (event.type === "stdout") output += event.data;
      if (event.type === "exit") code = event.code;
    }
    if (code === undefined) throw new Error("Computer command did not exit");
    return { code, stdout: output };
  } finally {
    clearTimeout(timer);
  }
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
    botId: "continuity-runtime",
    threadId: "continuity-thread",
    runId,
    prompt: "Docker continuity probe",
    instructions: "",
    history: [],
    tools: [],
    model: {
      provider: "openai-codex",
      id: "gpt-5.6-test",
      // This is intentionally not a credential. The real image must either
      // reject it without OAuth or complete the real app-server exchange.
      oauth: {
        credential: {
          type: "oauth",
          access: "continuity-not-a-real-access-token",
          refresh: "continuity-not-a-real-refresh-token",
          expires: 0,
          accountId: "continuity-no-auth",
        },
      },
    },
    execution: {
      choice: { harness: "codex-native", targetId: "continuity-computer" },
      authority: { runId, attemptId: `${runId}-attempt`, fence: 1, policyRevision: 1 },
      continuity,
      computerId: "continuity-computer",
    },
  };
}

type Stack = {
  root: string;
  context: AdapterContext;
  supervisor: ReturnType<typeof serve>;
  sandbox: DockerSandboxProvider;
  computer: ComputerRef;
};

describe.skipIf(!enabled).sequential("native continuity on real Docker", () => {
  let stack: Stack | undefined;

  beforeAll(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-continuity-"));
    const token = `continuity-${randomUUID()}`;
    const context: AdapterContext = {
      operationId: "continuity-docker",
      traceId: "continuity-docker",
      spaceId: "continuity-space",
      userId: "continuity-user",
      botId: "continuity-runtime",
      signal: AbortSignal.timeout(90_000),
    };
    let supervisor: ReturnType<typeof serve> | undefined;
    try {
      process.env.DATA_DIR = path.join(root, "data");
      process.env.RAKAZO_COMPUTER_IMAGE = "rakazo/computer-codex-0.154.0:local";
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
      await sandbox.writeFile(
        computer,
        { path: "continuity/.keep", content: new Uint8Array() },
        context,
      );
      stack = { root, context, supervisor, sandbox, computer };
    } catch (error) {
      await new Promise<void>((resolve) => supervisor?.close(() => resolve()) ?? resolve());
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }, 30_000);

  afterAll(async () => {
    if (!stack) return;
    const active = stack;
    await active.sandbox.destroy(active.computer, active.context).catch(() => undefined);
    await new Promise<void>((resolve) => active.supervisor.close(() => resolve()));
    await rm(active.root, { recursive: true, force: true }).catch(() => undefined);
  });

  it("stops a real TERM-resistant process, proves its group empty, and reconfirms another KILLed session", async () => {
    const { sandbox, computer, context } = stack!;
    const stubborn = await sandbox.startNativeProcess!(
      computer,
      {
        argv: [
          "sh",
          "-c",
          'pgid=$(ps -o pgid= -p $$ | tr -d " "); printf %s "$pgid" > continuity-stubborn.pgid; trap "" TERM; while :; do sleep 1; done',
        ],
        cwd: "continuity",
      },
      context,
    );
    const pgid = await waitForFile(
      sandbox,
      computer,
      context,
      "continuity/continuity-stubborn.pgid",
    );
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
          'pgid=$(ps -o pgid= -p $$ | tr -d " "); printf %s "$pgid" > continuity-reconfirm.pgid; trap "" TERM; while :; do sleep 1; done',
        ],
        cwd: "continuity",
      },
      context,
    );
    const reconfirmPgid = await waitForFile(
      sandbox,
      computer,
      context,
      "continuity/continuity-reconfirm.pgid",
    );
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

  it("runs the parked process probe after its original turn deadline has expired", async () => {
    const { sandbox, computer, context } = stack!;
    const native = await sandbox.startNativeProcess!(
      computer,
      { argv: ["sh", "-c", "while :; do sleep 1; done"], cwd: "continuity" },
      context,
    );
    const expiredContext = { ...context, signal: AbortSignal.timeout(1) };
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      await expect(
        commandOutput(
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
    const { sandbox, computer, context } = stack!;
    const homeA =
      "/tmp/rakazo-codex-continuity-runtime-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const homeB =
      "/tmp/rakazo-codex-continuity-runtime-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const start = (home: string) =>
      sandbox.startNativeProcess!(
        computer,
        {
          argv: [
            "sh",
            "-c",
            "pwd > .continuity-native-cwd; id -u > .continuity-native-uid; exec codex app-server --listen stdio://",
          ],
          cwd: "continuity",
          privateHome: home,
          env: { CI: "1", OPENAI_API_KEY: "", CODEX_HOME: home },
        },
        context,
      );
    const first = await start(homeA);
    try {
      const firstLines = first.stdout[Symbol.asyncIterator]();
      const initialized = await nativeRpc(first, firstLines, 1, "initialize", {
        clientInfo: { name: "rakazo-continuity", version: "test" },
        capabilities: { experimentalApi: true },
      });
      expect(initialized.error).toBeUndefined();
      await expect(
        sandbox
          .readFile(computer, "continuity/.continuity-native-cwd", context)
          .then((data) => new TextDecoder().decode(data)),
      ).resolves.toBe("/home/rakazo/continuity\n");
      await expect(
        sandbox
          .readFile(computer, "continuity/.continuity-native-uid", context)
          .then((data) => new TextDecoder().decode(data)),
      ).resolves.toBe("1000\n");
      await first.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`,
      );
      const created = await nativeRpc(first, firstLines, 2, "thread/start", {});
      if (created.error) {
        console.info(`CONTINUITY_NO_AUTH_THREAD_START=${redactNativeError(created.error.message)}`);
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
      console.info("CONTINUITY_HOME_MODE=700");
      await expect(first.stop()).resolves.toBe("stopped");
      const resumed = await start(homeA);
      try {
        const resumedLines = resumed.stdout[Symbol.asyncIterator]();
        expect(
          (
            await nativeRpc(resumed, resumedLines, 1, "initialize", {
              clientInfo: { name: "rakazo-continuity", version: "test" },
              capabilities: { experimentalApi: true },
            })
          ).error,
        ).toBeUndefined();
        await resumed.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`,
        );
        const noRollout = await nativeRpc(resumed, resumedLines, 2, "thread/resume", { threadId });
        expect(noRollout.error).toMatchObject({ code: -32600 });
        console.info(
          `CONTINUITY_NO_AUTH_SAME_HOME_RESUME=${redactNativeError(noRollout.error?.message)}`,
        );
      } finally {
        await resumed.stop().catch(() => undefined);
      }
      const fresh = await start(homeB);
      try {
        const freshLines = fresh.stdout[Symbol.asyncIterator]();
        expect(
          (
            await nativeRpc(fresh, freshLines, 1, "initialize", {
              clientInfo: { name: "rakazo-continuity", version: "test" },
              capabilities: { experimentalApi: true },
            })
          ).error,
        ).toBeUndefined();
        await fresh.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`,
        );
        const rejected = await nativeRpc(fresh, freshLines, 2, "thread/resume", { threadId });
        expect(rejected.error).toMatchObject({ code: -32600 });
        console.info(`CONTINUITY_FRESH_HOME_RESUME=${redactNativeError(rejected.error?.message)}`);
      } finally {
        await fresh.stop().catch(() => undefined);
      }
    } finally {
      await first.stop().catch(() => undefined);
    }
  }, 60_000);

  it.skipIf(!codexAuthEnabled)(
    "reconstructs through thread/resume with an authenticated Codex image (requires RUN_NATIVE_CONTINUITY_CODEX_AUTH=1)",
    async () => {
      const { sandbox, computer, context } = stack!;
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
      const runtime = new CodexNativeRuntime({
        sandbox: runtimeSandbox,
        computer,
        cwd: "continuity",
      });
      const firstEvents: AgentRuntimeEvent[] = [];
      try {
        for await (const event of runtime.run(
          nativeRequest("continuity-runtime-first", {
            mode: "new",
            ref: { bindingId: "continuity-runtime", generation: 0 },
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
          cwd: "continuity",
        });
        const reconstructed: AgentRuntimeEvent[] = [];
        for await (const event of reconstructedRuntime.run(
          nativeRequest("continuity-runtime-reconstruct", {
            mode: "reconstruct",
            previous: { bindingId: "continuity-runtime", generation: 0 },
            reason: "test_worker_lost",
            inputId: "continuity-reconstruct",
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
        await reconstructedRuntime.abort("continuity-runtime-reconstruct");
      } finally {
        await runtime.abort("continuity-runtime-first").catch(() => undefined);
      }
    },
    90_000,
  );
});
