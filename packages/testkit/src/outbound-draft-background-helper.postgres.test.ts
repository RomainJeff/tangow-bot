import { ComposioEmulator, composioEntityId, createConnectorStack } from "@rakazo/adapters";
import { HARNESSES } from "@rakazo/agent-run-worker";
import { describe, expect, it } from "vitest";
import { latestCard } from "./index.js";
import type { ModelEmulatorStep } from "./model-emulator.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

const recap = JSON.stringify({ version: 1, results: ["Answered"], references: [] });
const step = (response: ModelEmulatorStep["response"]): ModelEmulatorStep => ({
  expect() {},
  response,
});

describe.skipIf(!databaseAvailable)("a mail draft from a background helper", () => {
  it("is refused before it leaves a card, and sends nothing", async () => {
    const composio = new ComposioEmulator();
    let refusal = "";
    const run = await startWorkerRun({
      databaseUrl: process.env.DATABASE_URL!,
      harness: HARNESSES["pi-native"],
      computerScope: "none",
      tools: createConnectorStack(false, composio).connector,
      steps: [
        step({
          type: "tool",
          id: "spawn",
          name: "run_subagent",
          arguments: { name: "Mailer", task: "Mail Anna.", background: true },
        }),
        step({
          type: "tool",
          id: "say",
          name: "message_user",
          arguments: { message: "I've started that." },
        }),
        step({ type: "text", text: recap }),
        step({
          type: "tool",
          id: "mail",
          name: "GMAIL_SEND_EMAIL",
          arguments: { recipient_email: "anna@example.test", subject: "Hello", body: "Hi Anna." },
        }),
        {
          expect(request) {
            refusal = String(request.messages.at(-1)?.content);
          },
          response: { type: "text", text: "Mailing Anna needs the user." },
        },
      ],
    });
    try {
      await composio.begin(
        { provider: "GMAIL", redirectUrl: "http://127.0.0.1.invalid/callback" },
        {
          operationId: "helper-draft",
          traceId: "helper-draft",
          spaceId: run.spaceId,
          userId: run.userId,
          signal: new AbortController().signal,
        },
      );
      await run.prisma.connection.create({
        data: {
          spaceId: run.spaceId,
          userId: run.userId,
          provider: "GMAIL",
          displayName: "Gmail",
          status: "connected",
        },
      });
      const parentId = await run.send("Mail Anna in the background.");
      await run.continueRun(parentId);
      const child = await run.prisma.run.findFirstOrThrow({ where: { parentRunId: parentId } });
      await run.continueRun(child.id);

      // Its parent can send it itself, behind a draft card in the conversation.
      expect(refusal).toContain("which a background helper cannot ask for. Ask your parent");
      expect(await run.prisma.externalEffect.count({ where: { kind: "GMAIL_SEND_EMAIL" } })).toBe(
        0,
      );
      await expect(latestCard(run.prisma, child.id)).rejects.toThrow();
      await expect(latestCard(run.prisma, parentId)).rejects.toThrow();
      const mailbox = composio.mailboxFor(
        composioEntityId({ spaceId: run.spaceId, userId: run.userId }),
      );
      expect(
        mailbox?.messages.filter((message) => message.to === "anna@example.test") ?? [],
      ).toEqual([]);
      const reports = await run.prisma.sessionEntry.findMany({
        where: { type: "helper.report" },
        select: { payload: true },
      });
      expect(reports.map((entry) => entry.payload)).toMatchObject([
        { helperId: child.id, status: "completed", report: "Mailing Anna needs the user." },
      ]);
      const runs = await run.prisma.run.findMany({
        where: { threadId: run.thread.id },
        orderBy: { createdAt: "asc" },
        select: { trigger: true, status: true },
      });
      expect(runs.map(({ trigger, status }) => [trigger, status])).toEqual([
        ["user", "completed"],
        ["helper", "completed"],
        ["follow_up", "queued"],
      ]);
    } finally {
      await run.close();
    }
  }, 60_000);
});
