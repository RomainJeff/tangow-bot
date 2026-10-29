import { ComposioEmulator, composioEntityId } from "@rakazo/adapters";
import type { AskDraftEdits, ThreadEntry } from "@rakazo/contracts";
import { askDraftState } from "@rakazo/contracts";
import { projectThreadItems } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { latestCard } from "./index.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { prepares } from "./model-emulator.js";
import type { JourneyFixture } from "./pi-journey.test-support.js";
import { DONE, journey, reply, rpc, WAITING } from "./pi-journey.test-support.js";

/** The tools a worker offers the model, by their own names: the controller's carry an MCP prefix. */
const offeredTools = (request: ModelEmulatorRequest) =>
  request.tools?.map((tool) => tool.function.name.replace(/^mcp__rakazo__/, ""));

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

const RESUME_NOTE = "resuming this run after the user answered your draft card";

describe.skipIf(!databaseAvailable)("offline product journey", () => {
  describe("a mail draft", () => {
    const mail = {
      recipient_email: "someone@example.test",
      subject: "Hello",
      body: "Draft from the bot.",
      include_signature: false,
    };
    const array = (role: string, key: string) => ({
      role,
      path: [key],
      shape: "array",
      addresses: [],
    });
    const prepareMail = prepares({
      card: "mail",
      recipients: [
        { role: "to", path: ["recipient_email"], shape: "one", addresses: [mail.recipient_email] },
        array("to", "extra_recipients"),
        array("cc", "cc"),
        array("bcc", "bcc"),
      ],
      subject: { path: ["subject"], value: mail.subject },
      body: { path: ["body"], value: mail.body },
      unshown: [["include_signature"]],
    });
    const proposeMail: ModelEmulatorStep = {
      expect(request) {
        expect(offeredTools(request)).toContain("GMAIL_SEND_EMAIL");
        expect(JSON.stringify(request.messages)).not.toContain(RESUME_NOTE);
      },
      response: { type: "tool", id: "journey-mail", name: "GMAIL_SEND_EMAIL", arguments: mail },
    };
    /** Gmail connected through the Composio emulator for the fixture's user; its sent mail. */
    async function connectGmail(
      composio: ComposioEmulator,
      fixture: JourneyFixture,
      provider: "GMAIL" | "OUTLOOK" | "SLACK" = "GMAIL",
    ) {
      const { spaceId } = await fixture.prisma.bot.findUniqueOrThrow({
        where: { id: fixture.bot.id },
        select: { spaceId: true },
      });
      await composio.begin(
        { provider, redirectUrl: "http://127.0.0.1.invalid/callback" },
        {
          operationId: "journey",
          traceId: "journey",
          spaceId,
          userId: fixture.userId,
          signal: new AbortController().signal,
        },
      );
      await fixture.prisma.connection.create({
        data: {
          spaceId,
          userId: fixture.userId,
          provider,
          displayName: { GMAIL: "Gmail", OUTLOOK: "Outlook", SLACK: "Slack" }[provider],
          status: "pending",
        },
      });
      return () =>
        composio
          .mailboxFor(composioEntityId({ spaceId, userId: fixture.userId }))
          ?.messages.filter((message) => message.to === mail.recipient_email)
          .map((message) => message.messageText);
    }
    async function answerDraft(fixture: JourneyFixture, runId: string, edits?: AskDraftEdits) {
      const card = await latestCard(fixture.prisma, runId);
      await rpc(fixture.app, fixture.cookie, "threads/answer", {
        botId: fixture.bot.id,
        runId,
        messageId: card.id,
        answer: "allow",
        ...(edits ? { edits } : {}),
      });
    }

    it("leaves once, with the user's edit, before the bot's next turn", async () => {
      const composio = new ComposioEmulator();
      await journey(
        [
          proposeMail,
          prepareMail,
          WAITING,
          {
            expect(request) {
              expect(JSON.stringify(request.messages)).toContain(
                "The user sent this message from the draft card,",
              );
              expect(JSON.stringify(request.messages)).toContain("Edited by me.");
              expect(JSON.stringify(request.messages)).not.toContain("paused: awaiting approval");
              // The resume says so, and that another message may still be sent.
              expect(JSON.stringify(request.messages)).toContain(RESUME_NOTE);
              expect(JSON.stringify(request.messages)).toContain(
                "to send another message call the send tool again",
              );
            },
            response: reply("Sent."),
          },
          DONE,
        ],
        async (fixture) => {
          const mailed = await connectGmail(composio, fixture);
          const sent = await fixture.send("Mail them hello.");
          await sent.settled("waiting_input");
          await answerDraft(fixture, sent.runId, { text: "Edited by me." });
          await sent.settled("completed");
          expect(composio.executions.map((call) => [call.tool, call.args])).toEqual([
            ["GMAIL_SEND_EMAIL", { ...mail, body: "Edited by me." }],
          ]);
          expect(mailed()).toEqual(["Edited by me."]);
          // The run also records its message_user call, so the mail's row is read by its tool.
          const effects = await fixture.prisma.externalEffect.findMany({
            where: { runId: sent.runId, kind: "GMAIL_SEND_EMAIL" },
          });
          expect(effects).toMatchObject([
            { status: "completed", draft: { state: "sent", proposed: "Draft from the bot." } },
          ]);
        },
        { composio },
      );
    }, 30_000);

    it("leaves with the recipients and subject the user set, in Gmail's own fields", async () => {
      const composio = new ComposioEmulator();
      await journey(
        [
          proposeMail,
          prepareMail,
          WAITING,
          {
            expect(request) {
              const seen = JSON.stringify(request.messages);
              expect(seen).toContain("bo@example.test");
              expect(seen).toContain("Thursday instead");
            },
            response: reply("Sent."),
          },
          DONE,
        ],
        async (fixture) => {
          await connectGmail(composio, fixture);
          const sent = await fixture.send("Mail them hello.");
          await sent.settled("waiting_input");
          // Gmail's schema reaches the card, so every line is offered.
          expect((await latestCard(fixture.prisma, sent.runId)).block.draft?.fields).toEqual({
            to: null,
            cc: null,
            bcc: null,
            subject: true,
          });
          await answerDraft(fixture, sent.runId, {
            recipients: [
              { role: "to", address: "ana@example.test" },
              { role: "to", address: "bo@example.test" },
              { role: "cc", address: "cy@example.test" },
            ],
            subject: "Thursday instead",
          });
          await sent.settled("completed");
          expect(composio.executions.map((call) => [call.tool, call.args])).toEqual([
            [
              "GMAIL_SEND_EMAIL",
              {
                recipient_email: "ana@example.test",
                subject: "Thursday instead",
                body: "Draft from the bot.",
                include_signature: false,
                extra_recipients: ["bo@example.test"],
                cc: ["cy@example.test"],
              },
            ],
          ]);
        },
        { composio },
      );
    }, 30_000);

    it("leaves with the recipients and subject the user set, in Outlook's own fields", async () => {
      const composio = new ComposioEmulator();
      const outlook = { to: "someone@example.test", subject: "Hello", body: "Draft from the bot." };
      await journey(
        [
          {
            expect(request) {
              expect(offeredTools(request)).toContain("OUTLOOK_SEND_EMAIL");
            },
            response: {
              type: "tool",
              id: "journey-outlook",
              name: "OUTLOOK_SEND_EMAIL",
              arguments: outlook,
            },
          },
          prepares({
            card: "mail",
            recipients: [
              { role: "to", path: ["to"], shape: "one", addresses: [outlook.to] },
              array("cc", "cc_emails"),
              array("bcc", "bcc_emails"),
            ],
            subject: { path: ["subject"], value: outlook.subject },
            body: { path: ["body"], value: outlook.body },
            unshown: [],
          }),
          WAITING,
          { expect() {}, response: reply("Sent.") },
          DONE,
        ],
        async (fixture) => {
          await connectGmail(composio, fixture, "OUTLOOK");
          const sent = await fixture.send("Mail them hello.");
          await sent.settled("waiting_input");
          // Outlook's To is one address; its copies take any number.
          expect((await latestCard(fixture.prisma, sent.runId)).block.draft?.fields).toEqual({
            to: 1,
            cc: null,
            bcc: null,
            subject: true,
          });
          await answerDraft(fixture, sent.runId, {
            recipients: [
              { role: "to", address: "ana@example.test" },
              { role: "cc", address: "bo@example.test" },
              { role: "bcc", address: "cy@example.test" },
            ],
            subject: "Thursday instead",
          });
          await sent.settled("completed");
          expect(composio.executions.map((call) => [call.tool, call.args])).toEqual([
            [
              "OUTLOOK_SEND_EMAIL",
              {
                to: "ana@example.test",
                subject: "Thursday instead",
                body: "Draft from the bot.",
                cc_emails: ["bo@example.test"],
                bcc_emails: ["cy@example.test"],
              },
            ],
          ]);
        },
        { composio },
      );
    }, 30_000);

    it("posts a Slack message once, to the person Slack named, with the user's edit", async () => {
      const composio = new ComposioEmulator();
      const message = { channel: "D0MARIE", markdown_text: "Draft from the bot." };
      await journey(
        [
          {
            expect(request) {
              expect(offeredTools(request)).toContain("SLACK_SEND_MESSAGE");
            },
            response: {
              type: "tool",
              id: "journey-slack",
              name: "SLACK_SEND_MESSAGE",
              arguments: message,
            },
          },
          prepares({
            card: "chat",
            conversation: { path: ["channel"], value: message.channel },
            body: { path: ["markdown_text"], value: message.markdown_text },
            unshown: [],
          }),
          WAITING,
          {
            expect(request) {
              expect(JSON.stringify(request.messages)).toContain("Edited by me.");
            },
            response: reply("Sent."),
          },
          DONE,
        ],
        async (fixture) => {
          await connectGmail(composio, fixture, "SLACK");
          const sent = await fixture.send("Tell Marie on Slack.");
          await sent.settled("waiting_input");
          expect((await latestCard(fixture.prisma, sent.runId)).block.draft).toMatchObject({
            app: { name: "Slack" },
            recipients: [{ role: "to", address: "D0MARIE" }],
            conversation: { kind: "person", name: "Marie Dupont", handle: "marie" },
            body: "Draft from the bot.",
          });
          await answerDraft(fixture, sent.runId, { text: "Edited by me." });
          await sent.settled("completed");
          expect(composio.executions.map((call) => [call.tool, call.args])).toEqual([
            ["SLACK_RETRIEVE_CONVERSATION_INFORMATION", { channel: "D0MARIE" }],
            ["SLACK_RETRIEVE_DETAILED_USER_INFORMATION", { user: "U0MARIE" }],
            ["SLACK_SEND_MESSAGE", { ...message, markdown_text: "Edited by me." }],
          ]);
          const effects = await fixture.prisma.externalEffect.findMany({
            where: { runId: sent.runId, kind: "SLACK_SEND_MESSAGE" },
          });
          expect(effects).toMatchObject([
            { status: "completed", draft: { state: "sent", proposed: "Draft from the bot." } },
          ]);
        },
        { composio },
      );
    }, 30_000);

    it("asks the user to check Gmail when the send timed out after it left, sending nothing more", async () => {
      const composio = new ComposioEmulator();
      composio.failNext("GMAIL_SEND_EMAIL", { kind: "timeout" });
      await journey(
        [proposeMail, prepareMail, WAITING],
        async (fixture) => {
          const mailed = await connectGmail(composio, fixture);
          const sent = await fixture.send("Mail them hello.");
          await sent.settled("waiting_input");
          await answerDraft(fixture, sent.runId);
          await expect
            .poll(async () => (await latestCard(fixture.prisma, sent.runId)).block, {
              timeout: 15_000,
            })
            .toMatchObject({
              status: "pending",
              draft: { failure: { reason: "Check Gmail before trying again." } },
            });
          await sent.settled("waiting_input");
          expect(mailed()).toEqual(["Draft from the bot."]);
        },
        { composio },
      );
    }, 30_000);

    it("shows Not sent when Gmail refuses it, and Try again sends it once", async () => {
      const composio = new ComposioEmulator();
      composio.failNext("GMAIL_SEND_EMAIL", { kind: "fail", error: "Invalid recipient" });
      await journey(
        [
          proposeMail,
          prepareMail,
          WAITING,
          {
            expect(request) {
              const seen = JSON.stringify(request.messages);
              expect(seen).toContain("The user sent this message from the draft card,");
            },
            response: reply("Sent."),
          },
          DONE,
        ],
        async (fixture) => {
          const mailed = await connectGmail(composio, fixture);
          const sent = await fixture.send("Mail them hello.");
          await sent.settled("waiting_input");
          await answerDraft(fixture, sent.runId);
          await expect
            .poll(async () => (await latestCard(fixture.prisma, sent.runId)).block, {
              timeout: 15_000,
            })
            .toMatchObject({
              status: "pending",
              draft: { failure: { reason: "Invalid recipient" } },
            });
          await sent.settled("waiting_input");
          await answerDraft(fixture, sent.runId);
          await sent.settled("completed");
          expect(mailed()).toEqual(["Draft from the bot."]);
        },
        { composio },
      );
    }, 30_000);

    it("is replaced by what the user writes, the bot reading their edit and nothing leaving", async () => {
      const composio = new ComposioEmulator();
      await journey(
        [
          proposeMail,
          prepareMail,
          WAITING,
          {
            expect(request) {
              const seen = JSON.stringify(request.messages);
              expect(seen).toContain(
                "The user wrote to you instead of sending this draft, so nothing was sent.",
              );
              expect(seen).toContain("Edited by me.");
              expect(seen).toContain("Make it shorter.");
              expect(seen).not.toContain("paused: awaiting approval");
            },
            response: reply("Here is a shorter one."),
          },
          DONE,
        ],
        async (fixture) => {
          await connectGmail(composio, fixture);
          const sent = await fixture.send("Mail them hello.");
          await sent.settled("waiting_input");
          const card = await latestCard(fixture.prisma, sent.runId);
          await expect(
            fixture.send("Make it shorter.", {
              draft: { messageId: "entry_stale", text: "Edited by me." },
            }),
          ).rejects.toThrow("threads/send: 409");
          await fixture.send("Make it shorter.", {
            draft: { messageId: card.id, text: "Edited by me." },
          });
          await sent.settled("completed");

          expect(composio.executions).toEqual([]);
          const effect = await fixture.prisma.externalEffect.findFirstOrThrow({
            where: { runId: sent.runId, kind: "GMAIL_SEND_EMAIL" },
          });
          expect(effect).toMatchObject({
            status: "denied",
            draft: { state: "replaced", proposed: "Draft from the bot." },
          });
          const thread = await rpc<{ entries: ThreadEntry[] }>(
            fixture.app,
            fixture.cookie,
            "threads/get",
            { botId: fixture.bot.id },
          );
          const cards = projectThreadItems(thread.entries).flatMap((item) =>
            item.kind === "effect" && item.card ? [askDraftState(item.card)] : [],
          );
          expect(cards).toEqual(["replaced"]);
        },
        { composio },
      );
    }, 30_000);

    it("tells the bot about the replaced draft once, as its call's result, whatever it does next", async () => {
      const composio = new ComposioEmulator();
      // An answer to the bot's next card quotes the run's steps as they were, so only the history counts.
      const told = (request: ModelEmulatorRequest) =>
        JSON.stringify(request.messages)
          .replace(/<reply_target>[\s\S]*?<\/reply_target>/g, "")
          .split("editedByUser").length - 1;
      await journey(
        [
          proposeMail,
          prepareMail,
          WAITING,
          {
            expect(request) {
              expect(told(request)).toBe(1);
            },
            response: {
              type: "tool",
              id: "journey-which",
              name: "ask_user",
              arguments: { question: "Formal or casual?", options: ["Formal", "Casual"] },
            },
          },
          WAITING,
          {
            expect(request) {
              expect(told(request)).toBe(1);
            },
            response: reply("Here is a casual one."),
          },
          DONE,
        ],
        async (fixture) => {
          await connectGmail(composio, fixture);
          const sent = await fixture.send("Mail them hello.");
          await sent.settled("waiting_input");
          const card = await latestCard(fixture.prisma, sent.runId);
          await fixture.send("Make it shorter.", {
            draft: { messageId: card.id, text: "Edited by me." },
          });
          await expect
            .poll(async () => (await latestCard(fixture.prisma, sent.runId)).id, {
              timeout: 15_000,
            })
            .not.toBe(card.id);
          await sent.settled("waiting_input");
          const question = await latestCard(fixture.prisma, sent.runId);
          await rpc(fixture.app, fixture.cookie, "threads/answer", {
            botId: fixture.bot.id,
            runId: sent.runId,
            messageId: question.id,
            answer: "choice-2",
          });
          await sent.settled("completed");
          expect(composio.executions).toEqual([]);
        },
        { composio },
      );
    }, 30_000);
  });

  it("does not tell a run resumed after a plain question that it answered a draft card", async () => {
    await journey(
      [
        {
          expect() {},
          response: {
            type: "tool",
            id: "journey-which",
            name: "ask_user",
            arguments: { question: "Formal or casual?", options: ["Formal", "Casual"] },
          },
        },
        WAITING,
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Casual");
            expect(JSON.stringify(request.messages)).not.toContain(RESUME_NOTE);
          },
          response: reply("Casual it is."),
        },
        DONE,
      ],
      async (fixture) => {
        const sent = await fixture.send("Write to them.");
        await sent.settled("waiting_input");
        const question = await latestCard(fixture.prisma, sent.runId);
        await rpc(fixture.app, fixture.cookie, "threads/answer", {
          botId: fixture.bot.id,
          runId: sent.runId,
          messageId: question.id,
          answer: "choice-2",
        });
        await sent.settled("completed");
      },
    );
  }, 30_000);
});
