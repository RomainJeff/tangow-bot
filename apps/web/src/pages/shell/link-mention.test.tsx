// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import { SessionEntrySchema } from "@rakazo/contracts";
import { projectThreadView } from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function identityTag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}
vi.mock("@lingui/core/macro", () => ({ t: identityTag }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: identityTag }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));

const markdown = vi.hoisted(() => ({ parses: 0 }));
// By the path chat-ui imports it from: apps/web has no react-markdown of its own to name.
vi.mock("../../../../../packages/chat-ui/node_modules/react-markdown", async (importOriginal) => {
  const real = await importOriginal<{ default: (props: object) => ReactNode }>();
  return {
    ...real,
    default: (props: object) => {
      markdown.parses += 1;
      return real.default(props);
    },
  };
});

const api = vi.hoisted(() => ({ artifactsGet: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { artifacts: { get: api.artifactsGet } } }));

import type { MessageItem } from "../../lib/thread-items";
import { MessageView } from "./message-view";
import type { RowContext } from "./thread-row";
import { ThreadRowBody } from "./thread-row";

const DOC = "https://docs.example.test/d/abc";
const NOTION = "https://www.notion.so/acme/Roadmap-Q4-3f9a2c7e81d04b5f";

function message(role: "user" | "bot", blocks: unknown[]): MessageItem {
  return {
    kind: "message",
    id: "m1",
    ts: "2026-10-17T10:00:00.000Z",
    role,
    blocks: blocks as MessageBlock[],
    ...(role === "bot" ? { botId: "bot1" } : { source: "app" }),
  } as MessageItem;
}

const text = (value: string) => ({ kind: "text", text: value });
const mention = (url: string, extra: Record<string, unknown> = {}) => ({
  kind: "link_mention",
  url,
  ...extra,
});

/** Stable, as the thread memoizes it. */
const TARGET = { botId: "bot1" };

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:icon" }));
  api.artifactsGet.mockReset().mockResolvedValue({ contentBase64: "AAAA", mimeType: "image/webp" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderMessage(msg: MessageItem) {
  await act(async () => {
    root.render(
      <MessageView
        artifactTarget={TARGET}
        chrome="row"
        message={msg}
        inGroup={false}
        showAuthor={false}
        showAvatar={false}
        onOpenBot={() => undefined}
        peerBot={() => undefined}
        onRefresh={async () => undefined}
        onBotChanged={async () => undefined}
        onAddRoutine={() => undefined}
      />,
    );
  });
}

const mentions = () =>
  [...container.querySelectorAll<HTMLAnchorElement>('[data-slot="link-mention"]')].map((link) => ({
    name: link.getAttribute("aria-label"),
    title: link.getAttribute("title"),
    href: link.getAttribute("href"),
    label: link.querySelector("bdi.rk-link-mention-label")?.textContent,
    iconHidden: link.querySelector(".rk-link-mention-icon")?.getAttribute("aria-hidden"),
    icon: link.querySelector("img")?.getAttribute("src") ?? null,
    glyph: link.querySelector('[data-slot="link-mention-glyph"]') !== null,
    person: link.classList.contains("rk-linkified"),
  }));

describe("link mentions in the thread", () => {
  it("draws a bot's markdown link as its site's icon and the author's label, named with the host", async () => {
    await renderMessage(
      message("bot", [
        text(`Notes in [Compte rendu du 12](${DOC}), roadmap at https://plain.example.test/x`),
        mention(DOC, { title: "Untitled", icon: { artifactId: "icon-doc" } }),
      ]),
    );

    expect(mentions()).toEqual([
      {
        name: "Compte rendu du 12, docs.example.test",
        title: DOC,
        href: DOC,
        label: "Compte rendu du 12",
        iconHidden: "true",
        icon: "blob:icon",
        glyph: false,
        person: false,
      },
    ]);
    expect(api.artifactsGet).toHaveBeenCalledWith({ botId: "bot1", artifactId: "icon-doc" });
    const plain = container.querySelector<HTMLAnchorElement>(
      'a[href="https://plain.example.test/x"]',
    );
    expect(plain?.dataset.slot).toBeUndefined();
    expect(plain?.textContent).toBe("https://plain.example.test/x");
  });

  it("labels the person's bare link with the server's title, and the glyph stands in for a missing icon", async () => {
    await renderMessage(
      message("user", [
        text(`Tu peux relire ${NOTION.replace("https://", "")} avant demain ?`),
        mention(NOTION, { title: "Roadmap Q4" }),
      ]),
    );

    expect(mentions()).toEqual([
      {
        name: "Roadmap Q4, notion.so",
        title: NOTION,
        href: NOTION,
        label: "Roadmap Q4",
        iconHidden: "true",
        icon: null,
        glyph: true,
        person: true,
      },
    ]);
    expect(api.artifactsGet).not.toHaveBeenCalled();
  });

  it("falls back to the glyph when the icon cannot be read, and to the host alone as its name", async () => {
    api.artifactsGet.mockRejectedValue(new Error("gone"));
    await renderMessage(
      message("bot", [text(`see ${DOC}`), mention(DOC, { icon: { artifactId: "icon-gone" } })]),
    );

    expect(mentions()).toMatchObject([
      { name: "docs.example.test", label: "docs.example.test", icon: null, glyph: true },
    ]);
  });

  it("falls back to the glyph when the icon read is not an image the browser can decode", async () => {
    await renderMessage(
      message("bot", [text(`see ${DOC}`), mention(DOC, { icon: { artifactId: "icon-doc" } })]),
    );
    await act(async () => {
      container.querySelector("img")?.dispatchEvent(new Event("error"));
    });

    expect(mentions()).toMatchObject([{ icon: null, glyph: true }]);
  });

  it("does not re-parse a bot's markdown when the projection rebuilds an equal message", async () => {
    const blocks = () => [text(`Notes in [the doc](${DOC})`), mention(DOC, { title: "Doc" })];
    await renderMessage(message("bot", blocks()));
    markdown.parses = 0;
    await renderMessage(message("bot", blocks()));
    await renderMessage(message("bot", blocks()));
    expect(markdown.parses).toBe(0);

    await renderMessage(
      message("bot", [
        text(`Notes in [the doc](${DOC})`),
        mention(DOC, { title: "Doc", icon: { artifactId: "i" } }),
      ]),
    );
    expect(markdown.parses).toBe(1);
  });

  it("takes a bot's bare www. address for the https link the server read", async () => {
    await renderMessage(
      message("bot", [
        text("See www.example.test/plan today"),
        mention("https://www.example.test/plan", { title: "Plan" }),
      ]),
    );

    expect(mentions()).toMatchObject([
      { name: "Plan, example.test", href: "https://www.example.test/plan", label: "Plan" },
    ]);
  });

  it("names and titles a look-alike host by its real, ASCII host", async () => {
    const idn = "https://\u0430pple.example.test/login";
    const lookalike = "https://accounts.google.com.evil.test/x";
    await renderMessage(
      message("bot", [
        text(`[Apple](${idn}) and [Google sign-in](${lookalike})`),
        mention(idn),
        mention(lookalike),
      ]),
    );

    expect(mentions()).toMatchObject([
      {
        name: "Apple, xn--pple-43d.example.test",
        title: "https://xn--pple-43d.example.test/login",
      },
      { name: "Google sign-in, accounts.google.com.evil.test", title: lookalike },
    ]);
  });

  it("leaves the links of a message that is itself a card as plain links", async () => {
    await renderMessage(
      message("bot", [
        text(`see ${DOC}`),
        { kind: "ask", text: "Which?", status: "answered" },
        mention(DOC, { title: "Doc" }),
      ]),
    );

    expect(mentions()).toEqual([]);
  });
});

describe("link mentions in a routine's result", () => {
  const ARTICLE = "https://news.example.test/story";
  const routine = { botId: "bot1", runId: "run_digest" };
  const entries = [
    {
      ...routine,
      type: "routine.started",
      payload: {
        sessionId: "ses_digest",
        routineId: "rtn_digest",
        name: "Digest",
        trigger: "routine",
        scheduledAt: "2026-10-17T10:00:00.000Z",
        model: { provider: "local", id: "emulator-1" },
      },
    },
    {
      ...routine,
      type: "routine.finished",
      payload: {
        status: "completed",
        usage: { inputTokens: 1, outputTokens: 1 },
        result: `This week: [the story](${ARTICLE}) and the notes at ${DOC}`,
      },
    },
    {
      type: "link.preview",
      payload: {
        target: "e_1",
        block: { kind: "link_preview", url: ARTICLE, format: "compact", title: "The story" },
      },
    },
    {
      type: "link.preview",
      payload: {
        target: "e_1",
        block: mention(DOC, { title: "Compte rendu", icon: { artifactId: "icon-doc" } }),
      },
    },
  ].map((entry, seq) =>
    SessionEntrySchema.parse({
      id: `e_${seq}`,
      sessionId: "ses_main",
      seq,
      parentId: seq === 0 ? null : `e_${seq - 1}`,
      ts: `2026-10-17T10:00:0${seq}.000Z`,
      ...entry,
    }),
  );

  it("draws its links as mentions, with the card under the bubble", async () => {
    const [row] = projectThreadView(entries).rows;
    const context = {
      artifactTarget: TARGET,
      inGroup: false,
      waiting: null,
      peerBot: () => undefined,
      onOpenSession: () => undefined,
    } as unknown as RowContext;
    await act(async () => {
      root.render(
        <ThreadRowBody
          row={row!}
          context={context}
          chrome="row"
          showAuthor={false}
          showAvatar={false}
          arrivesLive={false}
        />,
      );
    });

    expect(container.querySelector('[data-testid="routine-message"]')).not.toBeNull();
    expect(mentions().map(({ name, href, icon }) => ({ name, href, icon }))).toEqual([
      { name: "Compte rendu, docs.example.test", href: DOC, icon: "blob:icon" },
    ]);
    expect(
      [...container.querySelectorAll('[data-slot="link-preview-card"]')].map((card) =>
        card.getAttribute("href"),
      ),
    ).toEqual([ARTICLE]);
  });
});
