import { ThreadItemSchema } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-localization", () => ({ getLocales: () => [{ languageTag: "en-US" }] }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./ui-direction", () => ({ applyMobileUiDirection: vi.fn() }));

import { botMessageCard } from "./bot-message-card";
import { resetI18nForTests } from "./i18n";

function card(item: Record<string, unknown>) {
  const parsed = ThreadItemSchema.parse({ id: "e_10", ts: "2026-10-10T09:00:00.000Z", ...item });
  if (parsed.kind !== "botMessage") throw new Error("not a bot message");
  return botMessageCard(parsed);
}

const researcher = { kind: "bot", botId: "bot_research", name: "Researcher" };
const received = {
  kind: "botMessage",
  direction: "received",
  peer: researcher,
  text: "Q3 numbers are in",
  intent: "result",
  exchangeId: "e_1",
  origin: { sessionId: "ses_research", entryId: "e_7" },
};

afterEach(() => resetI18nForTests("en"));

describe("a bot-to-bot card", () => {
  it("names its intent and links the sender's thread at the linked entry", () => {
    expect(card(received)).toEqual({
      before: "Message from ",
      peer: "Researcher",
      after: " · Result",
      label: "Message from Researcher · Result",
      muted: false,
      peerThread: {
        pathname: "/thread",
        params: { botId: "bot_research", name: "Researcher", messageId: "e_7" },
      },
    });
  });

  it("links a sent card to the peer's thread and mutes it until answered", () => {
    const sent = card({
      kind: "botMessage",
      direction: "sent",
      botId: "bot_chief",
      peer: researcher,
      text: "Pull the Q3 numbers",
      intent: "request",
      exchangeId: "e_10",
      answeredBy: null,
    });
    expect(sent.label).toBe("Messaged Researcher · Request");
    expect(sent.muted).toBe(true);
    expect(sent.peerThread).toEqual({
      pathname: "/thread",
      params: { botId: "bot_research", name: "Researcher" },
    });
  });

  it("gives another owner's agent no link", () => {
    const agent = card({
      ...received,
      intent: "fyi",
      peer: { kind: "agent", address: "agent@partner.example", name: "Partner" },
    });
    expect(agent.label).toBe("Message from Partner · FYI");
    expect(agent.peerThread).toBeNull();
  });

  it("keeps the peer where the translation puts it", () => {
    resetI18nForTests("zh-CN");
    const sent = card({ ...received, direction: "sent", botId: "bot_chief", answeredBy: "e_11" });
    expect([sent.before, sent.peer, sent.after]).toEqual(["已给 ", "Researcher", " 发消息 · 结果"]);
  });
});
