import { ComposioEmulator, composioEntityId, createConnectorStack } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import { latestCard } from "./index.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

const mailTo = (address: string, body: string, id: string): ModelEmulatorStep[] => [
  {
    expect() {},
    response: {
      type: "tool",
      id,
      name: "GMAIL_SEND_EMAIL",
      arguments: { recipient_email: address, subject: "Hello", body },
    },
  },
  { expect() {}, response: { type: "text", text: "Waiting." } },
];

/** The send calls to `address` the resumed model reads back among its earlier steps. */
const sendsTo = (request: ModelEmulatorRequest | undefined, address: string) =>
  JSON.stringify(request?.messages ?? [])
    .split("(already ran Gmail send email")
    .slice(1)
    .filter((step) => step.split(")")[0]!.includes(address));

describe.skipIf(!databaseAvailable)("mail drafts in a worker run", () => {
  it("tells the bot about a sent draft once, however many drafts follow it", async () => {
    const composio = new ComposioEmulator();
    let third: ModelEmulatorRequest | undefined;
    const run = await startWorkerRun({
      databaseUrl: process.env.DATABASE_URL!,
      computerScope: "none",
      tools: createConnectorStack(false, composio).connector,
      steps: [
        ...mailTo("anna@example.test", "First draft.", "mail-a"),
        ...mailTo("ben@example.test", "Second draft.", "mail-b"),
        {
          expect(request) {
            third = request;
          },
          response: {
            type: "tool",
            id: "say",
            name: "message_user",
            arguments: { message: "Both sent." },
          },
        },
        {
          expect() {},
          response: {
            type: "text",
            text: JSON.stringify({ version: 1, results: ["Sent both"], references: [] }),
          },
        },
      ],
    });
    try {
      const context = {
        operationId: "draft-worker",
        traceId: "draft-worker",
        spaceId: run.spaceId,
        userId: run.userId,
        signal: new AbortController().signal,
      };
      await composio.begin(
        { provider: "GMAIL", redirectUrl: "http://127.0.0.1.invalid/callback" },
        context,
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
      const sendAllowed = async (runId: string) => {
        const card = await latestCard(run.prisma, runId);
        expect(card.block).toMatchObject({ draft: { app: { name: "Gmail" } } });
        expect(
          await run.events.answerRunInput({
            spaceId: run.spaceId,
            threadId: run.thread.id,
            runId,
            messageId: card.id,
            answeredByUserId: run.userId,
            answer: "allow",
          }),
        ).toBe(true);
        await run.continueRun(runId);
      };

      const runId = await run.send("Mail Anna, then Ben.");
      await run.continueRun(runId);
      await sendAllowed(runId);
      await sendAllowed(runId);

      run.model.assertComplete();
      const mailbox = composio.mailboxFor(
        composioEntityId({ spaceId: run.spaceId, userId: run.userId }),
      );
      const sent = mailbox?.messages.filter((message) =>
        ["anna@example.test", "ben@example.test"].includes(message.to),
      );
      expect(sent?.map((message) => [message.to, message.messageText])).toEqual([
        ["anna@example.test", "First draft."],
        ["ben@example.test", "Second draft."],
      ]);
      expect(sendsTo(third, "anna@example.test")).toHaveLength(1);
      expect(JSON.stringify(third?.messages)).not.toContain(
        "Rakazo already ran what they approved",
      );
      expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
        "completed",
      );
    } finally {
      await run.close();
    }
  }, 60_000);
});
