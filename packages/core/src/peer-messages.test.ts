import { describe, expect, it } from "vitest";
import { peerConversations, stripPeerAddressPrefix } from "./peer-messages.js";
import { linkEntries } from "./session-log/fixtures/read-fixture.js";

const at = (second: number) => `2026-10-10T09:00:0${second}.000Z`;
const analyst = { kind: "bot", botId: "bot_analyst", name: "Analyst" };
const exchange = { hop: 1, exchangeId: "peer-1" };
const chain = linkEntries("peer", [
  {
    type: "user.message",
    payload: { blocks: [{ kind: "text", text: "hello" }], source: "app" },
  },
  {
    botId: "bot_ada",
    type: "bot.message.sent",
    payload: { to: analyst, text: "chart q3", intent: "request", ...exchange },
  },
  {
    type: "bot.message.received",
    payload: {
      from: { ...analyst, name: "Analyst 2" },
      fromSessionId: "ses_analyst",
      fromEntryId: "an-4",
      text: "done",
      intent: "result",
      ...exchange,
    },
  },
  {
    botId: "bot_ada",
    type: "bot.message.sent",
    payload: {
      to: { kind: "agent", address: "scout@example.test", name: "Scout" },
      text: "look into it",
      intent: "request",
      hop: 1,
      exchangeId: "peer-3",
    },
  },
]);

describe("peerConversations", () => {
  it("gathers each peer's exchange, newest name and activity first", () => {
    expect(peerConversations(chain)).toEqual([
      {
        peerBotId: "scout@example.test",
        peerBotName: "Scout",
        messages: [
          {
            messageId: "peer-3",
            direction: "sent",
            peerBotId: "scout@example.test",
            peerBotName: "Scout",
            text: "look into it",
            createdAt: at(3),
          },
        ],
        lastText: "look into it",
        lastAt: at(3),
      },
      {
        peerBotId: "bot_analyst",
        peerBotName: "Analyst 2",
        messages: [
          {
            messageId: "peer-1",
            direction: "sent",
            peerBotId: "bot_analyst",
            peerBotName: "Analyst",
            text: "chart q3",
            createdAt: at(1),
          },
          {
            messageId: "peer-2",
            direction: "received",
            peerBotId: "bot_analyst",
            peerBotName: "Analyst 2",
            text: "done",
            createdAt: at(2),
          },
        ],
        lastText: "done",
        lastAt: at(2),
      },
    ]);
  });
});

describe("stripPeerAddressPrefix", () => {
  it("removes a leading [to <name>] prefix", () => {
    expect(stripPeerAddressPrefix("[to Claudius] Salut")).toBe("Salut");
  });

  it("tolerates surrounding whitespace", () => {
    expect(stripPeerAddressPrefix("  [to Claudius]   Salut")).toBe("Salut");
  });

  it("leaves text with no prefix untouched", () => {
    expect(stripPeerAddressPrefix("Salut")).toBe("Salut");
  });

  it("only strips the leading prefix, not one later in the text", () => {
    expect(stripPeerAddressPrefix("[to Claudius] see [to Warren] later")).toBe(
      "see [to Warren] later",
    );
  });

  it("stops the name at the first closing bracket (non-greedy)", () => {
    expect(stripPeerAddressPrefix("[to A] [to B] hi")).toBe("[to B] hi");
  });

  it("does not match a bracket that never closes", () => {
    expect(stripPeerAddressPrefix("[to Claudius Salut")).toBe("[to Claudius Salut");
  });
});
