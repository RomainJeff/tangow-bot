import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { E2BSandboxProvider, ModelCallRuntime } from "@tangow/adapters";
import type { RunStatus } from "@tangow/contracts";
import { isTerminal } from "@tangow/core";
import { loadRootEnv } from "@tangow/core/node/load-root-env";
import { afterAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { computerOnVolumes, localWorkerApp } from "./local-worker-provider.js";

if (process.env.VERIFY_PROVIDERS) loadRootEnv();

const liveE2b = Boolean(process.env.VERIFY_PROVIDERS && process.env.E2B_API_KEY);
const livePi = Boolean(process.env.VERIFY_PROVIDERS && process.env.OPENROUTER_API_KEY);
const livePiApp = Boolean(livePi && process.env.DATABASE_URL);

const describeE2b = liveE2b ? describe : describe.skip;
const describePi = livePi ? describe : describe.skip;
const describePiApp = livePiApp ? describe : describe.skip;

describeE2b("live E2B canary", () => {
  it("provisions a desktop, runs a command, and destroys it", async () => {
    const sandbox = new E2BSandboxProvider(process.env.E2B_API_KEY!);
    const ctx = {
      operationId: "canary",
      traceId: "canary",
      spaceId: "canary",
      userId: "canary",
      signal: new AbortController().signal,
    };
    const computer = await sandbox.provision(
      { botId: "canary", homePath: "/home/user/tangow-home" },
      ctx,
    );
    try {
      await sandbox.prepare(computer, ctx);
      let stdout = "";
      for await (const event of sandbox.execute(computer, { argv: ["echo", "e2b-ok"] }, ctx)) {
        if (event.type === "stdout") stdout += event.data;
        if (event.type === "exit") expect(event.code).toBe(0);
      }
      expect(stdout).toContain("e2b-ok");
    } finally {
      await sandbox.destroy(computer, ctx);
    }
  }, 120_000);
});

describePi("live OpenRouter canary", () => {
  it("streams a reply from deepseek/deepseek-v4-flash-0731", async () => {
    const runtime = new ModelCallRuntime();
    let text = "";
    for await (const event of runtime.run(
      {
        botId: "canary",
        threadId: "canary",
        runId: `pi-${Date.now()}`,
        prompt: "Reply with exactly the word pong and nothing else.",
        instructions: "You are a concise test bot.",
        history: [],
        tools: [],
        model: {
          provider: "openrouter",
          id: "deepseek/deepseek-v4-flash-0731",
          apiKey: process.env.OPENROUTER_API_KEY,
        },
      },
      {
        operationId: "canary",
        traceId: "canary",
        spaceId: "canary",
        userId: "canary",
        signal: new AbortController().signal,
      },
    )) {
      if (event.type === "done" && event.text) text = event.text;
    }
    expect(text.trim().toLowerCase()).toBe("pong");
    expect(text).not.toMatch(/sk-or-|OPENROUTER_API_KEY/i);
  }, 90_000);
});

describePiApp("live OpenRouter product journey", () => {
  let stop: (() => Promise<void>) | undefined;
  let dataDir: string | undefined;

  afterAll(async () => {
    try {
      await stop?.();
    } finally {
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("completes a bot turn in a worker with the live model", async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-canary-"));
    const local = localWorkerApp(path.join(dataDir, "workers"));
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      ...local,
    });
    stop = async () => {
      try {
        await handles.stop();
      } finally {
        await local.workers.dispose();
      }
    };
    const stamp = Date.now();
    const email = `pi-${stamp}@rakazo.test`;
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "password12", name: "Pi Canary" }),
    });
    expect(signup.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(signup);
    const botRes = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
      name: "Chief",
      title: "Chief of staff",
      description: "Canary",
      instructions: "Reply briefly.",
      notifyOnFinish: true,
    });
    await computerOnVolumes(handles.prisma, botRes.id);
    const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
      botId: botRes.id,
      text: "Use the write tool to save notes/result.txt containing exactly openrouter-ok",
    });
    const run = await waitForRun(
      () =>
        handles.prisma.run.findUnique({
          where: { id: sent.runId },
          select: { status: true },
        }),
      90_000,
    );
    expect(run.status).toBe("completed");
    const snap = await rpc<Snap>(handles.app, cookie, "threads/get", { botId: botRes.id });
    const blob = JSON.stringify(snap);
    expect(blob).not.toMatch(/sk-or-/i);
    const file = await rpc<{ content: string }>(handles.app, cookie, "computer/readFile", {
      botId: botRes.id,
      path: "notes/result.txt",
    });
    expect(file.content).toBe("openrouter-ok");
  }, 120_000);
});

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type Snap = {
  messages: Array<{ role: string; blocks: unknown[] }>;
  run: { status: string } | null;
};

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
  });
  const parsed = (await res.json()) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error)
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? "failed"}`);
  return parsed.json as T;
}

async function waitForRun(load: () => Promise<{ status: string } | null>, ms: number) {
  const start = Date.now();
  let last: { status: string } | null = null;
  while (Date.now() - start < ms) {
    last = await load();
    if (last && isTerminal(last.status as RunStatus)) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timeout waiting for live model turn: ${last?.status ?? "not found"}`);
}
