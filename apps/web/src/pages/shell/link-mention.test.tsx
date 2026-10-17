// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
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

const api = vi.hoisted(() => ({ artifactsGet: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { artifacts: { get: api.artifactsGet } } }));

import type { MessageItem } from "../../lib/thread-items";
import { MessageView } from "./message-view";

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
        artifactTarget={{ botId: "bot1" }}
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
      message("bot", [text(`see ${DOC}`), mention(DOC, { icon: { artifactId: "icon-doc" } })]),
    );

    expect(mentions()).toMatchObject([
      { name: "docs.example.test", label: "docs.example.test", icon: null, glyph: true },
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
