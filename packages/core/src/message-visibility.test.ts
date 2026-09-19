import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { isAsideOnlyMessage, userVisibleMessages } from "./message-visibility.js";

function message(
  id: string,
  runId: string,
  blocks: ThreadMessage["blocks"],
  clientNonce?: string,
): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    blocks,
    runId,
    clientNonce,
    createdAt: "2026-08-30T22:00:00.000Z",
  };
}

const peerExchange = [
  message("user", "run-user", [{ kind: "text", text: "Please ask Coder." }]),
  message("sent", "run-user", [
    { kind: "bot_message_sent", toBotId: "coder", toBotName: "Coder", text: "Check this." },
  ]),
  message("received", "run-peer", [
    {
      kind: "bot_message_received",
      fromBotId: "coder",
      fromBotName: "Coder",
      text: "Done.",
    },
  ]),
  message("activity", "run-peer", [{ kind: "steps", steps: [{ label: "Message bot", count: 1 }] }]),
  // A delegating bot's own summary reaches the user through message_user (user-message nonce).
  message(
    "reply",
    "run-peer",
    [{ kind: "text", text: "Sent Coder the endpoints." }],
    "user-message:run-peer:1:z:z",
  ),
  message("answer", "run-user", [{ kind: "text", text: "Coder is checking it." }]),
];

describe("user-visible messages", () => {
  it("hides peer activity but keeps the bot's text reply to the user", () => {
    expect(userVisibleMessages(peerExchange).map((item) => item.id)).toEqual([
      "user",
      "reply",
      "answer",
    ]);
  });

  it("keeps compact peer receipts when includePeerReceipts is set", () => {
    expect(
      userVisibleMessages(peerExchange, { includePeerReceipts: true }).map((item) => item.id),
    ).toEqual(["user", "sent", "received", "reply", "answer"]);
  });

  it("keeps message_user and ask_user output from a delegated (peer) run", () => {
    const messages = [
      message("received", "run-peer", [
        { kind: "bot_message_received", fromBotId: "c", fromBotName: "Coder", text: "Do it." },
      ]),
      // Production narration carries a user-progress nonce (the executor publishes it before
      // every tool call), so it must not be mistaken for user-directed output.
      message(
        "narration",
        "run-peer",
        [{ kind: "text", text: "internal narration" }],
        "user-progress:run-peer:0:z:z",
      ),
      message(
        "hello",
        "run-peer",
        [{ kind: "text", text: "Bonjour Romain" }],
        "user-message:run-peer:1:z:z",
      ),
      message("question", "run-peer", [{ kind: "ask", text: "Ton horizon ?" }]),
    ];
    // message_user (nonce) and ask_user (ask block) reach the user; narration/receipts do not.
    expect(userVisibleMessages(messages).map((item) => item.id)).toEqual(["hello", "question"]);
  });

  it("uses authoritative peer run ids when the receipt is outside the loaded page", () => {
    const messages = [
      message("activity", "run-peer", [
        { kind: "steps", steps: [{ label: "Echoed peer reply", count: 1 }] },
      ]),
      message(
        "reply",
        "run-peer",
        [{ kind: "text", text: "Echoed peer reply" }],
        "user-message:run-peer:1:z:z",
      ),
      message("answer", "run-user", [{ kind: "text", text: "Visible answer" }]),
    ];

    expect(
      userVisibleMessages(messages, { knownPeerRunIds: ["run-peer"] }).map((item) => item.id),
    ).toEqual(["reply", "answer"]);
  });

  it("keeps a peer-run ask card and text reply while hiding other peer activity", () => {
    const messages = [
      message("ask", "run-peer", [
        {
          kind: "ask",
          text: "Pick one",
          status: "pending",
          actions: [{ id: "a", label: "A" }],
        },
      ]),
      message("activity", "run-peer", [{ kind: "steps", steps: [{ label: "Work", count: 1 }] }]),
      message(
        "reply",
        "run-peer",
        [{ kind: "text", text: "Peer body" }],
        "user-message:run-peer:1:z:z",
      ),
      message("answer", "run-user", [{ kind: "text", text: "Visible answer" }]),
    ];

    expect(
      userVisibleMessages(messages, { knownPeerRunIds: ["run-peer"] }).map((item) => item.id),
    ).toEqual(["ask", "reply", "answer"]);
  });
});

describe("isAsideOnlyMessage", () => {
  it("treats a delegation, a handoff, a channel note and a meta line as asides", () => {
    expect(
      isAsideOnlyMessage([
        { kind: "bot_message_sent", toBotId: "coder", toBotName: "Coder", text: "Check this." },
      ]),
    ).toBe(true);
    expect(
      isAsideOnlyMessage([
        { kind: "handoff", fromBotId: "chief", toBotId: "coder", text: "over to you" },
      ]),
    ).toBe(true);
    expect(
      isAsideOnlyMessage([
        {
          kind: "channel_message",
          provider: "matrix",
          channelId: "room-1",
          fromAddress: "someone@example.test",
          fromLabel: "Someone",
          text: "hello",
        },
      ]),
    ).toBe(true);
    expect(isAsideOnlyMessage([{ kind: "meta", text: "Run stopped" }])).toBe(true);
  });

  it("treats a bot_message_received-only message as an aside regardless of role", () => {
    // The server stores an inbound peer receipt with role "user" (it is the
    // recipient's prompt, but still peer activity: see bot-messages.ts). The
    // predicate takes no role argument, so this documents that callers must
    // classify it as an aside the same as any other role.
    expect(
      isAsideOnlyMessage([
        { kind: "bot_message_received", fromBotId: "coder", fromBotName: "Coder", text: "Done." },
      ]),
    ).toBe(true);
  });

  it("is not an aside as soon as the message says something itself", () => {
    expect(isAsideOnlyMessage([])).toBe(false);
    expect(isAsideOnlyMessage([{ kind: "text", text: "Done." }])).toBe(false);
    expect(
      isAsideOnlyMessage([
        { kind: "handoff", fromBotId: "chief", toBotId: "coder", text: "over to you" },
        { kind: "text", text: "Done." },
      ]),
    ).toBe(false);
  });
});
