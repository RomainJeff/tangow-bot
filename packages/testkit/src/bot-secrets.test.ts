import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { ScriptedAgentRuntime } from "@rakazo/adapters";
import { answerRunInput } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;
const destination = {
  name: "example_api",
  origin: "https://api.example.test",
  auth: { type: "bearer" },
};
const key = "fake-reusable-api-key";

describeIntegration("reusable credential lifecycle", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-secret-lifecycle-"));
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const auth = new Headers(init?.headers).get("Authorization");
    return Response.json({
      authenticated: auth === `Bearer ${key}` || auth === `Bearer ${key}-rotated`,
      echo: auth,
    });
  });

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
      remoteConnectors: {
        fetch,
        resolveHostname: async () => [{ address: "8.8.8.8", family: 4 }],
      },
    });
  });
  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it.each([false, true])(
    "saves, reuses, rotates and revokes without model-visible plaintext (approval rule: %s)",
    async (requireApproval) => {
      fetch.mockClear();
      const seen: string[] = [];
      let calls: Array<{ name: string; args: Record<string, unknown> }> = [
        {
          name: "request_secret",
          args: { label: "API key", purpose: "api_key", credential: destination },
        },
      ];
      const runtime = vi
        .spyOn(ScriptedAgentRuntime.prototype, "run")
        .mockImplementation(async function* (request): AsyncIterable<AgentRuntimeEvent> {
          seen.push(
            JSON.stringify({
              prompt: request.prompt,
              history: request.history,
              tools: request.tools,
            }),
          );
          for (const [index, call] of calls.entries()) {
            yield { type: "tool", ...call, executionId: `${request.runId}:${index}` };
          }
          yield { type: "done", text: "Done" };
        });
      try {
        const seeded = await seedRun(`reusable-${requireApproval}`, "Save the API credential");
        if (requireApproval) {
          await handles.prisma.actionApprovalRule.create({
            data: {
              spaceId: seeded.me.spaceId,
              createdByUserId: seeded.me.userId,
              effect: "require_approval",
              matchKind: "tool",
              matchValue: "request_secret",
            },
          });
        }
        await handles.executor.continueRun(seeded.run.id, "test-worker");
        const approve = async (runId: string, interruptBeforeCard = false) => {
          if (!requireApproval) return;
          const message = await handles.prisma.message.findFirstOrThrow({
            where: { runId, role: "bot" },
            orderBy: { createdAt: "desc" },
          });
          expect(message.blocks).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ approvalEffectId: expect.any(String) }),
            ]),
          );
          if (interruptBeforeCard) {
            // Reproduce a worker stopping after releasing the approved effect to intended,
            // before the protected card transaction commits. No background job is enqueued.
            expect(
              await answerRunInput(handles.prisma, {
                spaceId: seeded.me.spaceId,
                threadId: seeded.thread.id,
                runId,
                messageId: message.id,
                answeredByUserId: seeded.me.userId,
                answer: "allow",
              }),
            ).toBe(true);
            await handles.prisma.externalEffect.updateMany({
              where: { runId, kind: "request_secret", status: "approved" },
              data: { status: "intended" },
            });
            await handles.prisma.run.update({
              where: { id: runId },
              data: {
                status: "running",
                leaseOwner: "interrupted-worker",
                leaseExpiresAt: new Date(Date.now() - 60_000),
              },
            });
            await handles.executor.continueRun(runId, "recovery-worker");
          } else {
            await rpc(seeded.cookie, "threads/answer", {
              botId: seeded.bot.id,
              runId,
              messageId: message.id,
              answer: "allow",
            });
          }
          await vi.waitFor(
            async () => {
              const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: runId } });
              expect(["completed", "waiting_input"]).toContain(run.status);
            },
            { timeout: 15_000 },
          );
        };
        await approve(seeded.run.id);
        const answer = async (runId: string, value: string) => {
          const message = await handles.prisma.message.findFirstOrThrow({
            where: { runId, role: "bot" },
            orderBy: { createdAt: "desc" },
          });
          expect(message.blocks).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ input: "secret", credential: destination }),
            ]),
          );
          await rpc(seeded.cookie, "threads/answer", {
            botId: seeded.bot.id,
            runId,
            messageId: message.id,
            answer: value,
          });
          await vi.waitFor(
            async () => {
              expect(
                await handles.prisma.run.findUniqueOrThrow({ where: { id: runId } }),
              ).toMatchObject({ status: "completed", error: null });
            },
            { timeout: 15_000 },
          );
        };
        expect(
          await handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
        ).toMatchObject({ status: "waiting_input", error: null });
        // An invalid value rolls back the run transition and leaves the card pending.
        const pending = await handles.prisma.message.findFirstOrThrow({
          where: { runId: seeded.run.id, role: "bot" },
          orderBy: { seq: "desc" },
        });
        expect(pending.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "ask",
              input: "secret",
              status: "pending",
              credential: destination,
            }),
          ]),
        );
        for (const invalid of ["x".repeat(16_385), "key\r\nX-Evil: injected", "key "]) {
          await expect(
            rpc(seeded.cookie, "threads/answer", {
              botId: seeded.bot.id,
              runId: seeded.run.id,
              messageId: pending.id,
              answer: invalid,
            }),
          ).rejects.toThrow();
        }
        expect(
          await handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
        ).toMatchObject({ status: "waiting_input" });
        expect(await handles.prisma.botSecret.count({ where: { botId: seeded.bot.id } })).toBe(0);
        await answer(seeded.run.id, key);
        const stored = await handles.prisma.botSecret.findFirstOrThrow({
          where: { botId: seeded.bot.id },
        });
        expect(stored).toMatchObject({
          ...destination,
          userId: seeded.me.userId,
          spaceId: seeded.me.spaceId,
        });
        expect(stored.ciphertext).toMatch(/^v2:/);
        expect(stored.ciphertext).not.toContain(key);
        expect(
          await handles.prisma.secret.count({ where: { kind: `run-secret:${seeded.run.id}` } }),
        ).toBe(0);

        const nextRun = async (nextCalls: typeof calls) => {
          calls = nextCalls;
          const task = await handles.prisma.task.create({
            data: {
              userId: seeded.me.userId,
              spaceId: seeded.me.spaceId,
              botId: seeded.bot.id,
              threadId: seeded.thread.id,
              prompt: "Use the saved credential",
              status: "queued",
            },
          });
          const run = await handles.prisma.run.create({
            data: {
              userId: seeded.me.userId,
              spaceId: seeded.me.spaceId,
              botId: seeded.bot.id,
              threadId: seeded.thread.id,
              taskId: task.id,
              trigger: "user",
              status: "queued",
            },
          });
          await handles.executor.continueRun(run.id, "test-worker");
          return run.id;
        };
        const request = {
          name: "secret_request",
          args: { name: destination.name, url: `${destination.origin}/v1/items` },
        };
        const useRun = await nextRun([
          { name: "list_secrets", args: {} },
          {
            name: "request_secret",
            args: { label: "API key", purpose: "api_key", credential: destination },
          },
          request,
        ]);
        await approve(useRun);
        expect(await handles.prisma.run.findUniqueOrThrow({ where: { id: useRun } })).toMatchObject(
          {
            status: "completed",
            error: null,
          },
        );
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(
          await handles.prisma.externalEffect.findFirstOrThrow({
            where: { runId: useRun, kind: "secret_request" },
          }),
        ).toMatchObject({
          status: "completed",
          result: {
            status: 200,
            body: { authenticated: true, echo: expect.stringContaining("[redacted]") },
          },
        });

        const rotateRun = await nextRun([
          {
            name: "request_secret",
            args: { label: "API key", purpose: "api_key", credential: destination, replace: true },
          },
        ]);
        expect(
          await handles.prisma.run.findUniqueOrThrow({ where: { id: rotateRun } }),
        ).toMatchObject({ status: "waiting_input" });
        await approve(rotateRun, true);
        expect(
          await handles.prisma.run.findUniqueOrThrow({ where: { id: rotateRun } }),
        ).toMatchObject({ status: "waiting_input" });
        expect(
          await handles.prisma.botSecret.findUniqueOrThrow({ where: { id: stored.id } }),
        ).toMatchObject({ ciphertext: stored.ciphertext });
        await answer(rotateRun, `${key}-rotated`);
        expect(
          await handles.prisma.botSecret.findUniqueOrThrow({ where: { id: stored.id } }),
        ).not.toMatchObject({ ciphertext: stored.ciphertext });
        await nextRun([request]);
        expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get("Authorization")).toBe(
          `Bearer ${key}-rotated`,
        );
        const count = fetch.mock.calls.length;
        await nextRun([{ name: "forget_secret", args: { name: destination.name } }, request]);
        expect(await handles.prisma.botSecret.count({ where: { botId: seeded.bot.id } })).toBe(0);
        expect(fetch).toHaveBeenCalledTimes(count);
        const [messages, events, effects, tasks] = await Promise.all([
          handles.prisma.message.findMany({ where: { threadId: seeded.thread.id } }),
          handles.prisma.event.findMany({ where: { threadId: seeded.thread.id } }),
          handles.prisma.externalEffect.findMany({ where: { spaceId: seeded.me.spaceId } }),
          handles.prisma.task.findMany({ where: { botId: seeded.bot.id } }),
        ]);
        expect(JSON.stringify({ seen, messages, events, effects, tasks })).not.toContain(key);
      } finally {
        runtime.mockRestore();
      }
    },
  );

  describe("webhook key", () => {
    async function keyedBot(label: string) {
      const cookie = await signup(`webhook-${label}-${stamp}@rakazo.test`, `Webhook ${label}`);
      const me = await rpc<{ userId: string }>(cookie, "me");
      const bot = await rpc<{ id: string }>(cookie, "bots/create", {
        name: `Webhook ${label}`,
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      const read = (as = cookie) =>
        rpc<{ secret: string }>(as, "bots/webhookSecret", { botId: bot.id });
      const rotate = (input: { ifAbsent?: boolean } = {}) =>
        rpc<{ secret: string | null }>(cookie, "bots/rotateWebhookSecret", {
          botId: bot.id,
          ...input,
        });
      const accepts = async (secret: string) => {
        const body = JSON.stringify({ zen: "Keep it logically awesome." });
        const response = await handles.app.request(`/api/v1/bots/${bot.id}/github`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
          },
          body,
        });
        return response.status;
      };
      const stored = () =>
        handles.prisma.secret.count({ where: { userId: me.userId, kind: "webhook" } });
      const configured = async () =>
        (await rpc<{ webhookConfigured: boolean }>(cookie, "bots/get", { botId: bot.id }))
          .webhookConfigured;
      return { read, rotate, accepts, stored, configured };
    }

    it("gives the owner the bot's live key on every read, creating it on the first", async () => {
      const bot = await keyedBot("read");
      expect(await bot.configured()).toBe(false);

      const first = await bot.read();
      expect(first.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await bot.read()).toEqual(first);
      expect(await bot.accepts(first.secret)).toBe(200);
      expect(await bot.configured()).toBe(true);
      expect(await bot.stored()).toBe(1);
    });

    it("creates exactly one key when two first reads race", async () => {
      const bot = await keyedBot("race");
      const [one, two] = await Promise.all([bot.read(), bot.read()]);
      expect(one.secret).toBe(two.secret);
      expect(await bot.accepts(one.secret)).toBe(200);
      expect(await bot.stored()).toBe(1);
    });

    it("refuses the key to anyone but the bot's owner", async () => {
      const bot = await keyedBot("owner");
      const { secret } = await bot.read();
      const stranger = await signup(`webhook-stranger-${stamp}@rakazo.test`, "Webhook stranger");

      await expect(bot.read(stranger)).rejects.toThrow("bots/webhookSecret failed (500)");
      expect(await bot.read()).toEqual({ secret });
      expect(await bot.stored()).toBe(1);
    });

    it("reads the new key after a rotation, and the old one stops working", async () => {
      const bot = await keyedBot("rotate");
      const before = await bot.read();
      const rotated = await bot.rotate();

      expect(rotated.secret).not.toBe(before.secret);
      expect(await bot.read()).toEqual({ secret: rotated.secret });
      expect(await bot.accepts(before.secret)).toBe(401);
      expect(await bot.accepts(rotated.secret!)).toBe(200);
      expect(await bot.stored()).toBe(1);
    });

    it("still leaves a live key alone for app builds that rotate with ifAbsent", async () => {
      const bot = await keyedBot("if-absent");
      const { secret } = await bot.read();

      expect(await bot.rotate({ ifAbsent: true })).toMatchObject({ secret: null });
      expect(await bot.accepts(secret)).toBe(200);
      expect(await bot.stored()).toBe(1);
    });
  });

  async function seedRun(
    label: string,
    prompt: string,
    runState: {
      status?: string;
      leaseOwner?: string;
      leaseFence?: number;
      leaseExpiresAt?: Date;
      startedAt?: Date;
      completedAt?: Date;
    } = {},
  ) {
    const cookie = await signup(`executor-${label}-${stamp}@rakazo.test`, `Executor ${label}`);
    const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
    const bot = await rpc<{ id: string }>(cookie, "bots/create", {
      name: `Executor ${label}`,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const task = await handles.prisma.task.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        userId: me.userId,
        prompt,
        status: "queued",
      },
    });
    const run = await handles.prisma.run.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: me.userId,
        status: runState.status ?? "queued",
        trigger: "user",
        leaseOwner: runState.leaseOwner,
        leaseFence: runState.leaseFence,
        leaseExpiresAt: runState.leaseExpiresAt,
        startedAt: runState.startedAt,
        completedAt: runState.completedAt,
      },
    });
    return { cookie, me, bot, thread, task, run };
  }

  async function signup(email: string, name: string) {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "password12", name }),
    });
    expect(response.status).toBeLessThan(400);
    const raw = response.headers.get("set-cookie") ?? "";
    const match = raw.match(/better-auth\.session_token=([^;]+)/);
    expect(match?.[1]).toBeTruthy();
    return `better-auth.session_token=${match![1]}`;
  }

  async function rpc<T>(cookie: string, procedure: string, body: unknown = {}): Promise<T> {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
        cookie,
      },
      body: JSON.stringify({ json: body }),
    });
    const payload = (await response.json()) as { json?: T; error?: { message?: string } };
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message ?? `${procedure} failed (${response.status})`);
    }
    return payload.json as T;
  }
});
