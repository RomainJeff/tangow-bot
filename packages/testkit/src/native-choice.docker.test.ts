import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import type { DockerSandboxProvider } from "@rakazo/adapters";
import { ComposioEmulator, EncryptedSecretStore } from "@rakazo/adapters";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { describe, expect, it } from "vitest";
import { listSpaceRuns } from "../../../apps/api/src/runs.ts";
import { sessionCookieHeader } from "./index.ts";
import { startModelEmulator } from "./model-emulator.ts";

function codexNativeHome() {
  const home = `/tmp/rakazo-codex-${randomUUID()}`;
  return { privateHome: home, env: { CI: "1", OPENAI_API_KEY: "", CODEX_HOME: home } };
}

const enabled = process.env.RUN_NATIVE_CHOICE_DOCKER === "1";
const origin = "http://127.0.0.1:5173";
const fixture = `
const fs = require("node:fs");
let buffer = "";
let stdinEnded = false;
process.stdin.on("end", () => { stdinEnded = true; });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const newline = buffer.indexOf("\\n");
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") reply(message.id, {});
    if (message.method === "account/login/start") reply(message.id, { type: "chatgptAuthTokens" });
    if (message.method === "thread/start") reply(message.id, { thread: { id: "native-thread" } });
    if (message.method === "turn/start") {
      reply(message.id, { turn: { id: "native-turn" } });
      const text = message.params.input[0].text;
      fs.writeFileSync(process.env.CODEX_HOME + "/credential-cache", "synthetic");
      fs.writeFileSync("native-home.txt", process.env.CODEX_HOME + "\\n" + fs.statSync(process.env.CODEX_HOME).mode.toString(8).slice(-3));
      if (text === "Native crash") {
        fs.writeFileSync("native-crash-marker.txt", "exit-23");
        process.exit(23);
      }
      if (text === "Native stdin probe") {
        fs.writeFileSync("native-stdin-start.txt", "started");
        setTimeout(() => {
          fs.writeFileSync("native-stdin.txt", stdinEnded ? "closed" : "open");
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } }) + "\\n");
        }, 150);
        continue;
      }
      if (text === "Native liveness probe") {
        fs.writeFileSync("native-liveness.txt", "started");
        setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } }) + "\\n"), 6_000);
        continue;
      }
      if (text === "Native immediate notifications") {
        for (const message of [
          { method: "turn/started", params: {} },
          { method: "item/agentMessage/delta", params: { delta: "synthetic final result" } },
          { method: "turn/completed", params: { turn: { status: "completed" } } },
        ]) fs.writeSync(1, JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
        process.exit(0);
      }
      if (text === "Native unterminated completion") {
        fs.writeSync(1, JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: {} }) + "\\n");
        fs.writeSync(1, JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } }));
        process.exit(0);
      }
      fs.writeFileSync("native-marker.txt", "marker-from-computer");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "synthetic native result" } }) + "\\n");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } }) + "\\n");
    }
  }
});
`;

type Rpc = <T>(procedure: string, input: unknown) => Promise<T>;

async function waitForTerminal(
  prisma: Parameters<typeof listSpaceRuns>[0],
  actor: Parameters<typeof listSpaceRuns>[1],
  runId: string,
) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const runs = await listSpaceRuns(prisma, actor, "recent");
    const run = runs.find((candidate) => candidate.runId === runId);
    if (run && (run.status === "completed" || run.status === "failed")) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for terminal public run ${runId}`);
}

async function installFixture(
  sandbox: DockerSandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  workspacePath: string,
) {
  const write = async (path: string, content: string) =>
    sandbox.writeFile(computer, { path, content: Buffer.from(content) }, context);
  await write(`${workspacePath}/app-server-fixture.cjs`, fixture);
  const fixtureBase64 = Buffer.from(fixture).toString("base64");
  const setup = sandbox.execute(
    computer,
    {
      argv: [
        "sh",
        "-c",
        `mkdir -p /home/rakazo/.local/bin && printf '%s' '${fixtureBase64}' | base64 -d > /home/rakazo/.local/bin/app-server-fixture.cjs && printf '%s\\n' '#!/bin/sh' 'exec node /home/rakazo/.local/bin/app-server-fixture.cjs' > /home/rakazo/.local/bin/codex && chmod 700 /home/rakazo/.local/bin/codex`,
      ],
      cwd: ".",
      timeoutMs: 5_000,
    },
    context,
  );
  const events = [];
  for await (const event of setup) events.push(event);
  expect(events.at(-1)).toEqual({ type: "exit", code: 0 });
}

describe.skipIf(!enabled)("native harness choice on real Docker", () => {
  it("runs the selected codex-native fixture inside its authorized Computer and exposes completion or crash", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-native-choice-docker-"));
    const dataDir = path.join(root, "data");
    const token = `native-choice-${randomUUID()}`;
    const postgres = await new PostgreSqlContainer("postgres:16-alpine")
      .withLabels({ "rakazo.test": "native-choice" })
      .start();
    const model = await startModelEmulator({
      apiKey: "native-choice-test-key",
      steps: [],
    });
    let supervisor: ReturnType<typeof serve> | undefined;
    let handles:
      | Awaited<ReturnType<typeof import("../../../apps/api/src/app.ts")["createApp"]>>
      | undefined;
    let computer: ComputerRef | undefined;
    let context: AdapterContext | undefined;
    try {
      process.env.DATA_DIR = dataDir;
      process.env.RAKAZO_COMPUTER_IMAGE = "rakazo/computer:local";
      process.env.SANDBOX_SUPERVISOR_TOKEN = token;
      process.env.SANDBOX_PROVIDER = "docker";
      const { supervisorApp } = await import("../../../infra/sandboxes/supervisor/src/index.ts");
      supervisor = serve({
        fetch: supervisorApp.fetch,
        hostname: "127.0.0.1",
        port: 0,
      });
      if (!supervisor.listening)
        await new Promise<void>((resolve, reject) => {
          supervisor!.once("error", reject);
          supervisor!.once("listening", resolve);
        });
      const supervisorUrl = `http://127.0.0.1:${(supervisor.address() as AddressInfo).port}`;
      const databaseUrl = postgres.getConnectionUri();
      process.env.DATABASE_URL = databaseUrl;
      process.env.REALTIME_DATABASE_URL = databaseUrl;
      execFileSync("pnpm", ["--filter", "@rakazo/db", "generate"], {
        stdio: "inherit",
      });
      execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", "migrate", "deploy"], {
        cwd: path.resolve("packages/db"),
        stdio: "inherit",
        env: { ...process.env, DATABASE_URL: databaseUrl },
      });
      const { createApp } = await import("../../../apps/api/src/app.ts");
      handles = await createApp({
        databaseUrl,
        realtimeDatabaseUrl: databaseUrl,
        authUrl: origin,
        webOrigin: origin,
        dataDir,
        sandboxProvider: "docker",
        sandboxSupervisorUrl: supervisorUrl,
        sandboxSupervisorToken: token,
        agentRuntime: "scripted",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        composio: new ComposioEmulator(),
        encryptionKey: "native-choice-encryption-key",
      });
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `native-choice-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Native choice Docker",
        }),
      });
      const cookie = sessionCookieHeader(signup);
      const rpc: Rpc = async (procedure, input) => {
        const response = await handles!.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: JSON.stringify({ json: input }),
        });
        const body = (await response.json()) as {
          json?: unknown;
          error?: { message?: string };
        };
        if (!response.ok || body.error)
          throw new Error(body.error?.message ?? `${procedure} failed`);
        return body.json as never;
      };
      const actor = await rpc<{ userId: string; spaceId: string }>("me", {});
      const bot = await rpc<{ id: string }>("bots/create", {
        name: "Native choice",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      const secretId = randomUUID();
      const credentialId = randomUUID();
      const store = new EncryptedSecretStore("native-choice-encryption-key");
      const encrypted = await store.put(
        JSON.stringify({
          type: "oauth",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: Date.now() + 3_600_000,
          accountId: "synthetic-account",
        }),
        {
          operationId: "fixture",
          traceId: "fixture",
          userId: actor.userId,
          spaceId: actor.spaceId,
          signal: new AbortController().signal,
        },
        secretId,
      );
      await handles.prisma.secret.create({
        data: {
          id: secretId,
          userId: actor.userId,
          kind: "model",
          ciphertext: encrypted.ciphertext,
        },
      });
      await handles.prisma.userModelCredential.create({
        data: {
          id: credentialId,
          userId: actor.userId,
          provider: "openai-codex",
          label: "Synthetic subscription",
          secretId,
        },
      });
      await handles.prisma.spaceModelPreference.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          credentialId,
          modelId: "gpt-5.6-terra",
          isDefault: true,
        },
      });
      await rpc("bots/update", {
        botId: bot.id,
        modelProvider: "openai-codex",
        modelId: "gpt-5.6-terra",
      });
      const storedBot = await handles.prisma.bot.findUniqueOrThrow({
        where: { id: bot.id },
        include: { computer: true },
      });
      expect(storedBot.computer).toMatchObject({ kind: "docker" });
      context = {
        operationId: "native-choice-fixture",
        traceId: "native-choice-fixture",
        spaceId: storedBot.spaceId,
        userId: storedBot.userId,
        botId: storedBot.id,
        signal: AbortSignal.timeout(30_000),
      };
      await Promise.all([
        mkdir(path.join(dataDir, "skills", "marketplaces", context.spaceId), {
          recursive: true,
        }),
        mkdir(path.join(dataDir, "skills", "user", context.spaceId, context.userId), {
          recursive: true,
        }),
      ]);
      const sandbox = handles.sandbox as DockerSandboxProvider;
      computer = await sandbox.provision(
        {
          botId: storedBot.computer!.homeKey,
          homePath: path.join(dataDir, "homes", storedBot.computer!.homeKey),
        },
        context,
      );
      await handles.prisma.computer.update({
        where: { id: storedBot.computer!.id },
        data: { providerRef: computer.providerRef, state: "running" },
      });
      await installFixture(sandbox, computer, context, `bots/${storedBot.id}`);
      const eofProcess = await sandbox.startNativeProcess(
        computer,
        {
          argv: ["codex", "app-server", "--listen", "stdio://"],
          cwd: `bots/${storedBot.id}`,
          ...codexNativeHome(),
        },
        context,
      );
      const eofLines: string[] = [];
      const drainEof = (async () => {
        for await (const line of eofProcess.stdout) eofLines.push(line);
      })();
      for (const message of [
        { id: 1, method: "initialize", params: {} },
        { id: 2, method: "account/login/start", params: {} },
        { id: 3, method: "thread/start", params: {} },
        {
          id: 4,
          method: "turn/start",
          params: { input: [{ type: "text", text: "Native crash" }] },
        },
      ])
        await eofProcess.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      await drainEof;
      await expect(
        sandbox
          .readFile(computer, `bots/${storedBot.id}/native-crash-marker.txt`, context)
          .then((content) => new TextDecoder().decode(content)),
      ).resolves.toBe("exit-23");
      expect(eofLines).toHaveLength(4);
      await expect(eofProcess.wait()).resolves.toMatchObject({ code: 23 });
      await expect(eofProcess.stop()).resolves.toBe("stopped");
      const stdinProbe = await sandbox.startNativeProcess(
        computer,
        {
          argv: ["codex", "app-server", "--listen", "stdio://"],
          cwd: `bots/${storedBot.id}`,
          ...codexNativeHome(),
        },
        context,
      );
      const stdinProbeLines: string[] = [];
      const completedProbe = new Promise<boolean>((resolve, reject) => {
        (async () => {
          try {
            for await (const line of stdinProbe.stdout) {
              stdinProbeLines.push(line);
              if (line.includes('"method":"turn/completed"')) return resolve(true);
            }
            resolve(false);
          } catch (error) {
            reject(error);
          }
        })();
      });
      for (const message of [
        { id: 1, method: "initialize", params: {} },
        { method: "initialized", params: {} },
        { id: 2, method: "account/login/start", params: {} },
        { id: 3, method: "thread/start", params: {} },
        {
          id: 4,
          method: "turn/start",
          params: { input: [{ type: "text", text: "Native stdin probe" }] },
        },
      ])
        await stdinProbe.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      const probeCompleted = await completedProbe;
      const probeExit = probeCompleted ? undefined : await stdinProbe.wait();
      const probeStarted = await sandbox
        .readFile(computer, `bots/${storedBot.id}/native-stdin-start.txt`, context)
        .then((content) => new TextDecoder().decode(content))
        .catch(() => "missing");
      const stdinState = await sandbox
        .readFile(computer, `bots/${storedBot.id}/native-stdin.txt`, context)
        .then((content) => new TextDecoder().decode(content))
        .catch(() => "missing");
      expect({ probeCompleted, probeExit, probeStarted, stdinState }).toEqual({
        probeCompleted: true,
        probeExit: undefined,
        probeStarted: "started",
        stdinState: "open",
      });
      expect(stdinProbeLines).toHaveLength(5);
      await expect(stdinProbe.stop()).resolves.toBe("stopped");
      const livenessProbe = await sandbox.startNativeProcess(
        computer,
        {
          argv: ["codex", "app-server", "--listen", "stdio://"],
          cwd: `bots/${storedBot.id}`,
          ...codexNativeHome(),
        },
        context,
      );
      const livenessLines: string[] = [];
      const livenessIterator = livenessProbe.stdout[Symbol.asyncIterator]();
      for (const message of [
        { id: 1, method: "initialize", params: {} },
        { method: "initialized", params: {} },
        { id: 2, method: "account/login/start", params: {} },
        { id: 3, method: "thread/start", params: {} },
        {
          id: 4,
          method: "turn/start",
          params: { input: [{ type: "text", text: "Native liveness probe" }] },
        },
      ])
        await livenessProbe.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      while (livenessLines.length < 3) {
        const next = await livenessIterator.next();
        expect(next.done).toBe(false);
        livenessLines.push(next.value!);
      }
      await expect(
        Promise.race([
          livenessIterator.next().then(
            () => "emitted",
            () => "emitted",
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve("quiet"), 5_000)),
        ]),
      ).resolves.toBe("quiet");
      await expect(livenessProbe.stop()).resolves.toBe("stopped");
      const immediateExit = await sandbox.startNativeProcess(
        computer,
        {
          argv: ["codex", "app-server", "--listen", "stdio://"],
          cwd: `bots/${storedBot.id}`,
          ...codexNativeHome(),
        },
        context,
      );
      const immediateExitLines: string[] = [];
      const drainImmediateExit = (async () => {
        for await (const line of immediateExit.stdout) immediateExitLines.push(line);
      })();
      for (const message of [
        { id: 1, method: "initialize", params: {} },
        { method: "initialized", params: {} },
        { id: 2, method: "account/login/start", params: {} },
        { id: 3, method: "thread/start", params: {} },
        {
          id: 4,
          method: "turn/start",
          params: {
            input: [{ type: "text", text: "Native immediate notifications" }],
          },
        },
      ])
        await immediateExit.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      await drainImmediateExit;
      expect(
        immediateExitLines.map((line) => JSON.parse(line).method ?? JSON.parse(line).id),
      ).toEqual([1, 2, 3, 4, "turn/started", "item/agentMessage/delta", "turn/completed"]);
      await expect(immediateExit.wait()).resolves.toMatchObject({
        code: 0,
        exitSource: "wrapper_exit_file",
      });
      await expect(immediateExit.stop()).resolves.toBe("stopped");
      const wrapperKilled = await sandbox.startNativeProcess(
        computer,
        {
          argv: ["sh", "-c", 'kill -KILL "$PPID"; sleep 0.05; exit 42'],
          cwd: `bots/${storedBot.id}`,
        },
        context,
      );
      for await (const _line of wrapperKilled.stdout) undefined;
      await expect(wrapperKilled.wait()).resolves.toMatchObject({
        code: null,
        exitSource: "unknown_after_missing_wrapper_exit",
      });
      await expect(wrapperKilled.stop()).resolves.toBe("stopped");
      const unterminatedCompletion = await sandbox.startNativeProcess(
        computer,
        {
          argv: ["codex", "app-server", "--listen", "stdio://"],
          cwd: `bots/${storedBot.id}`,
          ...codexNativeHome(),
        },
        context,
      );
      const unterminatedLines: string[] = [];
      const drainUnterminatedCompletion = (async () => {
        for await (const line of unterminatedCompletion.stdout) unterminatedLines.push(line);
      })();
      for (const message of [
        { id: 1, method: "initialize", params: {} },
        { method: "initialized", params: {} },
        { id: 2, method: "account/login/start", params: {} },
        { id: 3, method: "thread/start", params: {} },
        {
          id: 4,
          method: "turn/start",
          params: {
            input: [{ type: "text", text: "Native unterminated completion" }],
          },
        },
      ])
        await unterminatedCompletion.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      await drainUnterminatedCompletion;
      expect(
        unterminatedLines.map((line) => JSON.parse(line).method ?? JSON.parse(line).id),
      ).toEqual([1, 2, 3, 4, "turn/started", "turn/completed"]);
      await expect(unterminatedCompletion.wait()).resolves.toMatchObject({
        code: 0,
      });
      await expect(unterminatedCompletion.stop()).resolves.toBe("stopped");
      for await (const _event of sandbox.execute(
        computer,
        { argv: ["sh", "-c", "touch /tmp/native-choice-unrelated"], cwd: "." },
        context,
      ))
        undefined;
      const send = (text: string) =>
        rpc<{ runId: string }>("threads/send", {
          botId: bot.id,
          text,
          harness: "codex-native",
          executionTarget: storedBot.computer!.id,
        });
      const completed = await send("Native complete");
      await handles.executor
        .continueRun(completed.runId, "native-choice-docker-complete")
        .catch(async (error) => {
          const run = await handles!.prisma.run.findUniqueOrThrow({
            where: { id: completed.runId },
          });
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}: ${run.error ?? "no run error"}`,
          );
        });
      const publicCompleted = await waitForTerminal(handles.prisma, actor, completed.runId);
      if (publicCompleted.status !== "completed") {
        const failed = await handles.prisma.run.findUniqueOrThrow({
          where: { id: completed.runId },
        });
        throw new Error(`native completion failed: ${failed.error ?? "no run error"}`);
      }
      await expect(
        handles.sandbox
          .readFile(computer, `bots/${bot.id}/native-marker.txt`, context)
          .then((content) => new TextDecoder().decode(content)),
      ).resolves.toBe("marker-from-computer");
      const home = new TextDecoder()
        .decode(await handles.sandbox.readFile(computer, `bots/${bot.id}/native-home.txt`, context))
        .split("\n");
      expect(home[1]).toBe("700");
      const verifyPurged = [];
      for await (const event of sandbox.execute(
        computer,
        {
          argv: [
            "sh",
            "-c",
            'test ! -e "$1" && test -e /tmp/native-choice-unrelated',
            "sh",
            home[0]!,
          ],
          cwd: ".",
        },
        context,
      ))
        verifyPurged.push(event);
      expect(verifyPurged.at(-1)).toEqual({ type: "exit", code: 0 });
      const crashed = await send("Native crash");
      await handles.executor.continueRun(crashed.runId, "native-choice-docker-crash");
      await expect(waitForTerminal(handles.prisma, actor, crashed.runId)).resolves.toMatchObject({
        status: "failed",
      });
    } finally {
      if (computer && context)
        await handles?.sandbox.destroy(computer, context).catch(() => undefined);
      await handles?.stop().catch(() => undefined);
      if (supervisor) await new Promise<void>((resolve) => supervisor!.close(() => resolve()));
      await model.close();
      await postgres.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
