import type { HarnessDeclaration } from "@rakazo/adapter-kit";
import { ComposioEmulator, composioEntityId, createConnectorStack } from "@rakazo/adapters";
import { createWorkerAgentRuntime } from "@rakazo/adapters/runtime-worker";
import { HELPER_STOPPED_FOR_PAUSE } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  manualLauncher,
  rawGuest,
} from "../../adapters/src/runtime-worker/raw-guest.test-support.js";
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

const PI_NATIVE: HarnessDeclaration = {
  name: "pi-native",
  capabilities: ["native-loop", "subagents"],
};

async function connectGmail(
  composio: ComposioEmulator,
  run: Awaited<ReturnType<typeof startWorkerRun>>,
) {
  await composio.begin(
    { provider: "GMAIL", redirectUrl: "http://127.0.0.1.invalid/callback" },
    {
      operationId: "draft-worker",
      traceId: "draft-worker",
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
}

describe.skipIf(!databaseAvailable)("mail drafts in a worker run", () => {
  it("tells the bot how each draft was sent, once, however many drafts follow it", async () => {
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
      await connectGmail(composio, run);
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
      for (const address of ["anna@example.test", "ben@example.test"]) {
        const [call, ...rest] = sendsTo(third, address);
        expect(rest).toEqual([]);
        expect(call).toContain("The user sent this message from the draft card.");
      }
      expect(JSON.stringify(third?.messages)).not.toContain("paused: awaiting approval");
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

  it("logs how a helper's draft ended when the user sends it before the helper has stopped", async () => {
    const composio = new ComposioEmulator();
    const launcher = manualLauncher(PI_NATIVE);
    const runtime = createWorkerAgentRuntime({
      launcher: launcher.launcher,
      stops: { mark: async () => undefined },
    });
    const run = await startWorkerRun({
      databaseUrl: process.env.DATABASE_URL!,
      computerScope: "none",
      tools: createConnectorStack(false, composio).connector,
      steps: [],
      runtime: () => runtime,
    });
    try {
      await connectGmail(composio, run);
      const runId = await run.send("Have the helper mail Anna.");
      const paused = run.continueRun(runId);
      const first = await launcher.launchedFor(runId);
      const guest = rawGuest(first.connect(), first.capability, PI_NATIVE);
      await guest.hello();
      guest.send(1, { type: "tool", name: "run_subagent", args: {}, executionId: "helper" });
      guest.send(2, {
        type: "tool.call",
        agent: "root",
        callId: "helper",
        name: "run_subagent",
        args: { name: "Mailer", task: "Mail Anna." },
      });
      expect((await guest.replies(2, 1))[0]).toMatchObject({ agent: "helper:1" });
      guest.send(3, { type: "tool", name: "GMAIL_SEND_EMAIL", args: {}, executionId: "mail" });
      guest.send(4, {
        type: "tool.call",
        agent: "helper:1",
        callId: "mail",
        name: "GMAIL_SEND_EMAIL",
        args: { recipient_email: "anna@example.test", subject: "Hello", body: "Hi Anna." },
      });
      await guest.replies(4);
      expect((await guest.replies(2)).at(-1)).toEqual({
        type: "tool.result",
        output: HELPER_STOPPED_FOR_PAUSE,
      });

      // The user sends the draft while the helper is still closing, before its stop is logged.
      const card = await latestCard(run.prisma, runId);
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
      const resumed = run.continueRun(runId);
      const second = await vi.waitFor(
        async () => {
          const launched = await launcher.launchedFor(runId);
          if (launched === first) throw new Error("The run has not resumed yet");
          return launched;
        },
        { timeout: 15_000 },
      );
      const start = await rawGuest(second.connect(), second.capability, PI_NATIVE).hello();
      // The resumed attempt reads no outcome, so it is not told there is one.
      expect(JSON.stringify(start)).not.toContain(
        "resuming this run after the user answered your draft card",
      );

      guest.send(5, {
        type: "subagent.finish",
        agent: "helper:1",
        status: "completed",
        result: "",
      });
      expect(await guest.replies(5)).toEqual([{ type: "recorded" }]);
      guest.send(6, { type: "done" });
      await paused;

      // The helper's late stop gets the outcome, so a later run reads the mail as sent.
      const entries = await run.runEntries(runId);
      const stop = entries.find((entry) => entry.type === "subagent");
      expect(stop).toMatchObject({
        payload: { callId: "helper", result: HELPER_STOPPED_FOR_PAUSE },
      });
      expect(
        entries.filter((entry) => entry.type === "tool.result" && entry.payload.replaces),
      ).toMatchObject([
        {
          payload: {
            callId: "helper",
            replaces: stop!.id,
            output: expect.stringContaining("The user sent this message from the draft card."),
          },
        },
      ]);
      expect(
        composio
          .mailboxFor(composioEntityId({ spaceId: run.spaceId, userId: run.userId }))
          ?.messages.filter((message) => message.to === "anna@example.test")
          .map((message) => message.messageText),
      ).toEqual(["Hi Anna."]);
      await runtime.abort(runId);
      await resumed;
    } finally {
      await run.close();
    }
  }, 60_000);
});
