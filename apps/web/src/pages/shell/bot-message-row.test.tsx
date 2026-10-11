// @vitest-environment jsdom

import type { ThreadItem } from "@rakazo/contracts";
import { ThreadItemSchema } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function identityTag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}
vi.mock("@lingui/core/macro", () => ({ t: identityTag }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: identityTag, i18n: { locale: "en" } }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../../lib/rpc", () => ({ rpc: {} }));

import type { RowContext } from "./thread-row";
import { ThreadRowBody } from "./thread-row";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const opened: { thread: [string, string | undefined][]; exchange: string[] } = {
  thread: [],
  exchange: [],
};

async function render(item: Record<string, unknown>) {
  opened.thread = [];
  opened.exchange = [];
  const context = {
    artifactTarget: { botId: "bot_chief" },
    inGroup: false,
    waiting: null,
    peerBot: () => undefined,
    onOpenBot: (botId: string, messageId?: string) => opened.thread.push([botId, messageId]),
    onOpenPeerMessages: ({ peerBotId }: { peerBotId: string }) => opened.exchange.push(peerBotId),
    onOpenSession: () => undefined,
    onRefresh: async () => undefined,
    onBotChanged: async () => undefined,
    onAddRoutine: () => undefined,
    messageOfEntry: () => undefined,
  } as unknown as RowContext;
  const row = {
    item: ThreadItemSchema.parse({ id: "e_10", ts: "2026-10-10T09:00:00.000Z", ...item }),
    firstOfGroup: true,
    lastOfGroup: true,
    reactions: [],
  };
  await act(async () => {
    root.render(
      <ThreadRowBody
        row={row as { item: ThreadItem } & typeof row}
        context={context}
        chrome="aside"
        showAuthor={false}
        showAvatar={false}
        arrivesLive={false}
      />,
    );
  });
  return container.querySelector<HTMLElement>('[data-testid="peer-receipt-chip"]')!;
}

const researcher = { kind: "bot", botId: "bot_research", name: "Researcher" };

describe("a bot-to-bot card", () => {
  it("names its intent and opens the sender's thread at the linked entry", async () => {
    const card = await render({
      kind: "botMessage",
      direction: "received",
      peer: researcher,
      text: "Q3 numbers are in",
      intent: "result",
      exchangeId: "e_1",
      origin: { sessionId: "ses_research", entryId: "e_7" },
    });

    expect(card.textContent).toBe("Message from Researcher · Result");
    expect(card.getAttribute("aria-label")).toBe("Message from Researcher · Result");
    expect(card.classList.contains("opacity-60")).toBe(false);
    const link = card.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/app/bot_research?m=e_7");
    await act(async () => link.click());
    expect(opened.thread).toEqual([["bot_research", "e_7"]]);
    expect(opened.exchange).toEqual([]);

    await act(async () => card.querySelector("button")!.click());
    expect(opened.exchange).toEqual(["bot_research"]);
  });

  it("links a sent card to the peer's thread and stays muted until answered", async () => {
    const card = await render({
      kind: "botMessage",
      direction: "sent",
      botId: "bot_chief",
      peer: researcher,
      text: "Pull the Q3 numbers",
      intent: "request",
      exchangeId: "e_10",
      answeredBy: null,
    });

    expect(card.textContent).toBe("Messaged Researcher · Request");
    expect(card.querySelector("a")!.getAttribute("href")).toBe("/app/bot_research");
    expect(card.classList.contains("opacity-60")).toBe(true);
  });

  it("gives another owner's agent no link and no opener", async () => {
    const card = await render({
      kind: "botMessage",
      direction: "received",
      peer: { kind: "agent", address: "agent@partner.example", name: "Partner" },
      text: "FYI the invoice went out",
      intent: "fyi",
      exchangeId: "e_1",
      origin: { sessionId: "ses_partner", entryId: "e_7" },
    });

    expect(card.textContent).toBe("Message from Partner · FYI");
    expect(card.querySelector("a")).toBeNull();
    expect(card.querySelector("button")).toBeNull();
  });
});
