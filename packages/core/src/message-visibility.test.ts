import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { isAsideOnlyMessage, userVisibleMessages } from "./message-visibility.js";

function message(
  id: string,
  runId: string,
  blocks: ThreadMessage["blocks"],
  clientNonce?: string,
  seq = 1,
): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq,
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
    expect(
      userVisibleMessages(peerExchange, { knownPeerRunIds: ["run-peer"] }).map((item) => item.id),
    ).toEqual(["user", "reply", "answer"]);
  });

  it("keeps compact peer receipts when includePeerReceipts is set", () => {
    expect(
      userVisibleMessages(peerExchange, {
        knownPeerRunIds: ["run-peer"],
        includePeerReceipts: true,
      }).map((item) => item.id),
    ).toEqual(["user", "sent", "received", "reply", "answer"]);
  });

  it("keeps a top-level bot's relay run, which the caller does not list as a peer run", () => {
    // A `bot_message` run on a bot with no parent is the orchestrator answering the user with
    // what its peer reported (background-work-visibility CA5/CA7). The server leaves those rows
    // in the page precisely because they must show, so nothing here may hide them again: the
    // `bot_message_received` receipt sharing their run id is not evidence of a hidden peer run.
    const relay = [
      message("received", "run-relay", [
        { kind: "bot_message_received", fromBotId: "coder", fromBotName: "Coder", text: "Done." },
      ]),
      message("relayed", "run-relay", [{ kind: "text", text: "Coder finished: it is done." }]),
    ];

    expect(userVisibleMessages(relay).map((item) => item.id)).toEqual(["relayed"]);
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
    expect(
      userVisibleMessages(messages, { knownPeerRunIds: ["run-peer"] }).map((item) => item.id),
    ).toEqual(["hello", "question"]);
  });

  it("hides a long peer final while keeping the explicit user outcome", () => {
    const messages = [
      message("received", "run-peer", [
        { kind: "bot_message_received", fromBotId: "c", fromBotName: "Coder", text: "Done." },
      ]),
      message("internal-final", "run-peer", [{ kind: "text", text: "x".repeat(700) }]),
      message(
        "outcome",
        "run-peer",
        [{ kind: "text", text: "The requested work is complete: see the attached brief." }],
        "user-message:outcome:1:z:z",
      ),
    ];

    expect(
      userVisibleMessages(messages, {
        knownPeerRunIds: ["run-peer", "wake-first", "wake-latest"],
      }).map((item) => item.id),
    ).toEqual(["outcome"]);
  });

  it("keeps file and image deliveries from a delegated run with a user outcome, without its narration", () => {
    const messages = [
      message(
        "received",
        "run-peer",
        [
          {
            kind: "bot_message_received",
            fromBotId: "c",
            fromBotName: "Coder",
            text: "Deliver it.",
          },
        ],
        undefined,
        19,
      ),
      message(
        "file",
        "run-peer",
        [
          {
            kind: "file",
            artifactId: "artifact-1",
            mimeType: "application/pdf",
            name: "specialist-delivery.pdf",
            size: 123,
          },
        ],
        undefined,
        20,
      ),
      message(
        "image",
        "run-peer",
        [
          {
            kind: "image",
            artifactId: "artifact-2",
            mimeType: "image/png",
            name: "specialist-visual.png",
          },
        ],
        undefined,
        21,
      ),
      message(
        "mixed",
        "run-peer",
        [
          {
            kind: "file",
            artifactId: "artifact-mixed",
            mimeType: "application/pdf",
            name: "do-not-show-with-narration.pdf",
            size: 123,
          },
          { kind: "text", text: "internal narration" },
        ],
        undefined,
        22,
      ),
      message(
        "narration",
        "run-peer",
        [{ kind: "text", text: "internal narration" }],
        undefined,
        23,
      ),
      message(
        "outcome",
        "run-peer",
        [{ kind: "text", text: "The specialist delivery is ready." }],
        "user-message:outcome:run-peer",
        24,
      ),
      message("answer", "run-user", [{ kind: "text", text: "Visible answer" }], undefined, 25),
    ];

    expect(
      userVisibleMessages(messages, {
        knownPeerRunIds: ["run-peer", "wake-first", "wake-latest"],
      }).map((item) => item.id),
    ).toEqual(["file", "image", "outcome", "answer"]);
  });

  it("shows attachments only for the wake selected by a mission outcome", () => {
    const messages = [
      message(
        "received-first",
        "wake-first",
        [
          {
            kind: "bot_message_received",
            fromBotId: "child",
            fromBotName: "Child",
            text: "First.",
          },
        ],
        undefined,
        30,
      ),
      message(
        "first-file",
        "wake-first",
        [
          {
            kind: "file",
            artifactId: "first-artifact",
            mimeType: "application/pdf",
            name: "first.pdf",
            size: 1,
          },
        ],
        undefined,
        31,
      ),
      message(
        "received-latest",
        "wake-latest",
        [
          {
            kind: "bot_message_received",
            fromBotId: "child",
            fromBotName: "Child",
            text: "Latest.",
          },
        ],
        undefined,
        32,
      ),
      message(
        "latest-file",
        "wake-latest",
        [
          {
            kind: "file",
            artifactId: "latest-artifact",
            mimeType: "application/pdf",
            name: "latest.pdf",
            size: 1,
          },
        ],
        undefined,
        33,
      ),
      message(
        "mission-outcome",
        "wake-latest",
        [{ kind: "text", text: "The consolidated result is ready." }],
        "user-message:outcome:mission:return-latest",
        34,
      ),
    ];

    expect(
      userVisibleMessages(messages, {
        knownPeerRunIds: ["run-peer", "wake-first", "wake-latest"],
      }).map((item) => item.id),
    ).toEqual(["latest-file", "mission-outcome"]);
  });

  it("hides internal peer files and images when the run has no user outcome", () => {
    const messages = [
      message(
        "received",
        "run-peer",
        [
          {
            kind: "bot_message_received",
            fromBotId: "c",
            fromBotName: "Coder",
            text: "Investigate.",
          },
        ],
        undefined,
        19,
      ),
      message(
        "narration",
        "run-peer",
        [{ kind: "text", text: "internal narration" }],
        undefined,
        20,
      ),
      message(
        "file",
        "run-peer",
        [
          {
            kind: "file",
            artifactId: "artifact-internal",
            mimeType: "application/pdf",
            name: "working-notes.pdf",
            size: 123,
          },
        ],
        undefined,
        21,
      ),
      message(
        "image",
        "run-peer",
        [
          {
            kind: "image",
            artifactId: "artifact-internal-image",
            mimeType: "image/png",
            name: "working-visual.png",
          },
        ],
        undefined,
        22,
      ),
      message("answer", "run-user", [{ kind: "text", text: "Visible answer" }], undefined, 23),
    ];

    expect(
      userVisibleMessages(messages, {
        knownPeerRunIds: ["run-peer", "wake-first", "wake-latest"],
      }).map((item) => item.id),
    ).toEqual(["answer"]);
  });

  it("keeps sidebar previews silent while known peer runs still reveal an explicit file in chat", () => {
    const messages = [
      message(
        "file",
        "run-peer",
        [
          {
            kind: "file",
            artifactId: "artifact-1",
            mimeType: "application/pdf",
            name: "specialist-delivery.pdf",
            size: 123,
          },
        ],
        undefined,
        20,
      ),
      message(
        "image",
        "run-peer",
        [
          {
            kind: "image",
            artifactId: "artifact-2",
            mimeType: "image/png",
            name: "specialist-visual.png",
          },
        ],
        undefined,
        21,
      ),
      message(
        "outcome",
        "run-peer",
        [{ kind: "text", text: "The specialist delivery is ready." }],
        "user-message:outcome:run-peer",
        22,
      ),
      message("answer", "run-user", [{ kind: "text", text: "Visible answer" }], undefined, 23),
    ];

    expect(
      userVisibleMessages(messages, { knownPeerRunIds: ["run-peer"] }).map((item) => item.id),
    ).toEqual(["file", "image", "outcome", "answer"]);
    expect(
      userVisibleMessages(messages, {
        knownPeerRunIds: ["run-peer"],
        includeDelegatedReplyText: false,
      }).map((item) => item.id),
    ).toEqual(["answer"]);
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
