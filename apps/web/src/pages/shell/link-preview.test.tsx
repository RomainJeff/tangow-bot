// @vitest-environment jsdom

import type { MessageBlock } from "@tangow/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest doesn't run the lingui macro transform: same passthrough as the other web tests.
function identityTag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}
vi.mock("@lingui/core/macro", () => ({ t: identityTag }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: identityTag }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));

const api = vi.hoisted(() => ({
  removeLinkPreview: vi.fn(),
  artifactsGet: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    messages: { removeLinkPreview: api.removeLinkPreview },
    artifacts: { get: api.artifactsGet },
  },
}));

import { copyableMessageText } from "../../lib/message-text";
import type { MessageItem } from "../../lib/thread-items";
import { MessageHoverActions, UserMessageActions } from "./message-hover-actions";
import { MessageView } from "./message-view";

const URL_A = "https://example.com/article";

function message(role: "user" | "bot", blocks: unknown[]): MessageItem {
  return {
    kind: "message",
    id: "m1",
    ts: "2026-10-05T10:00:00.000Z",
    role,
    blocks: blocks as MessageBlock[],
    ...(role === "bot" ? { botId: "bot1" } : { source: "app" }),
  } as MessageItem;
}

const text = (value: string) => ({ kind: "text", text: value });
const card = (overrides: Record<string, unknown> = {}) => ({
  kind: "link_preview",
  url: URL_A,
  format: "compact",
  title: "An article",
  ...overrides,
});
const IMAGE = { artifactId: "art1", width: 1200, height: 628 };

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:preview" }));
  api.removeLinkPreview.mockReset().mockResolvedValue({ ok: true });
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

async function renderMessage(msg: MessageItem, extra: { replyToMessageId?: string } = {}) {
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
        {...extra}
      />,
    );
  });
}

const cards = () =>
  container.querySelectorAll<HTMLAnchorElement>('[data-slot="link-preview-card"]');
const bubbles = () =>
  container.querySelectorAll('[data-slot="user-bubble"], [data-slot="message-row-bubble"]');

describe("link preview in the thread", () => {
  it("draws no card on a message that is itself a card, as on iOS and the server", async () => {
    await renderMessage(
      message("bot", [
        text(`look ${URL_A}`),
        { kind: "ask", text: "Which?", status: "answered" },
        card(),
      ]),
    );

    expect(cards()).toHaveLength(0);
  });

  it.each(["compact", "large", "photo"] as const)(
    "draws a %s card under the bubble",
    async (format) => {
      const blocks = [
        text(`look ${URL_A}`),
        card({
          format,
          ...(format === "compact" ? {} : { image: IMAGE }),
          title: format === "photo" ? undefined : "An article",
        }),
      ];
      await renderMessage(message("user", blocks));

      expect(bubbles()).toHaveLength(1);
      expect(cards()).toHaveLength(1);
      const link = cards()[0]!;
      expect(link.dataset.format).toBe(format);
      expect(link.getAttribute("href")).toBe(URL_A);
      expect(link.getAttribute("rel")).toBe("noreferrer noopener");
      expect(link.getAttribute("aria-label")).toBe(
        format === "photo" ? "example.com" : "An article, example.com",
      );
      // The card comes after the bubble.
      expect(
        bubbles()[0]!.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    },
  );

  it("aligns the card to the end for the person and to the start for a bot", async () => {
    await renderMessage(message("user", [text(`hi ${URL_A}`), card()]));
    expect(cards()[0]!.parentElement?.className).toContain("justify-end");
    await renderMessage(message("bot", [text(`hi ${URL_A}`), card()]));
    expect(cards()[0]!.parentElement?.className).toContain("justify-start");
  });

  it("caps the card like the bubble it stands for, so its side still says who sent it", async () => {
    await renderMessage(message("user", [text(URL_A), card()]));
    expect(cards()[0]!.className).toContain("max-w-39/50");
    expect(cards()[0]!.className).not.toContain("max-w-full");
    await renderMessage(message("bot", [text(URL_A), card()]));
    expect(cards()[0]!.className).toContain("max-w-41/50");
  });

  it("takes the bubble's place when the message is only its link", async () => {
    await renderMessage(message("user", [text(URL_A), card()]));
    expect(bubbles()).toHaveLength(0);
    expect(cards()).toHaveLength(1);

    await renderMessage(message("user", [text(`<${URL_A}>`), card()]));
    expect(bubbles()).toHaveLength(0);

    await renderMessage(
      message("user", [text(URL_A), card(), { kind: "link_mention", url: URL_A, title: "A" }]),
    );
    expect(bubbles()).toHaveLength(0);
    expect(cards()).toHaveLength(1);

    // Preview removed: the bubble is back, the card gone.
    await renderMessage(
      message("user", [text(URL_A), { kind: "link_preview", url: URL_A, removed: true }]),
    );
    expect(bubbles()).toHaveLength(1);
    expect(cards()).toHaveLength(0);
  });

  it("keeps the reply quote above a card that takes the bubble's place", async () => {
    await renderMessage(message("user", [text(URL_A), card()]), { replyToMessageId: "m0" });

    expect(bubbles()).toHaveLength(0);
    expect(cards()).toHaveLength(1);
    const quote = container.querySelector('[data-testid="reply-parent-preview"]');
    expect(quote).not.toBeNull();
    expect(
      quote!.compareDocumentPosition(cards()[0]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("handles a bot's narration the same way: card under the bubble, or alone", async () => {
    await renderMessage(message("bot", [text(`read ${URL_A}`), card()]));
    expect(bubbles()).toHaveLength(1);
    expect(cards()).toHaveLength(1);

    await renderMessage(message("bot", [text(URL_A), card()]));
    expect(bubbles()).toHaveLength(0);
    expect(cards()).toHaveLength(1);
    expect(container.querySelector('[data-slot="message-row"]')).not.toBeNull();
  });

  it("keeps the bubble above the card as soon as there is one more word", async () => {
    await renderMessage(message("user", [text(`${URL_A} wow`), card()]));
    expect(bubbles()).toHaveLength(1);
    expect(cards()).toHaveLength(1);
  });

  it("shows the site's initial in the thumbnail of a compact card without a picture (CA 77)", async () => {
    await renderMessage(message("bot", [text(`read ${URL_A}`), card()]));
    const initial = cards()[0]!.querySelector('[data-slot="link-preview-initial"]');
    expect(initial?.textContent).toBe("E");
    expect(initial?.getAttribute("aria-hidden")).toBe("true");
    expect(cards()[0]!.getAttribute("aria-label")).toBe("An article, example.com");

    await renderMessage(message("bot", [text(`read ${URL_A}`), card({ image: IMAGE })]));
    expect(cards()[0]!.querySelector('[data-slot="link-preview-initial"]')).toBeNull();
  });

  describe("the line that is only the link", () => {
    const bubbleTexts = () => [...bubbles()].map((bubble) => bubble.textContent);

    it.each(["bot", "user"] as const)(
      "is not drawn in a %s's bubble, the text around it stays (CA 78)",
      async (role) => {
        await renderMessage(message(role, [text(`Voici l'article :\n${URL_A}`), card()]));
        expect(bubbleTexts()).toEqual(["Voici l'article :"]);
        expect(container.textContent).not.toContain(URL_A);
        expect(cards()).toHaveLength(1);
      },
    );

    it.each(["bot", "user"] as const)(
      "stays when the link is in the middle of a %s's sentence",
      async (role) => {
        await renderMessage(message(role, [text(`Regarde ${URL_A} c'est bien`), card()]));
        expect(bubbleTexts()[0]).toContain(URL_A);
      },
    );

    it("handles the <url> and [url](url) forms and several lines", async () => {
      await renderMessage(
        message("user", [text(`Un\n<${URL_A}>\n\nDeux\n[${URL_A}](${URL_A})`), card()]),
      );
      expect(bubbleTexts()[0]).not.toContain("example.com");
      expect(bubbleTexts()[0]).toContain("Un");
      expect(bubbleTexts()[0]).toContain("Deux");
    });

    it("is still drawn when the preview was removed, and in a message with no card", async () => {
      await renderMessage(
        message("bot", [
          text(`Voici :\n${URL_A}`),
          { kind: "link_preview", url: URL_A, removed: true },
        ]),
      );
      expect(bubbleTexts()[0]).toContain(URL_A);
      await renderMessage(message("user", [text(`Voici :\n${URL_A}`)]));
      expect(bubbleTexts()[0]).toContain(URL_A);
    });

    it("keeps the link in what Copy puts on the clipboard (CA 79)", () => {
      const full = message("bot", [text(`Voici l'article :\n${URL_A}`), card()]);
      expect(copyableMessageText(full)).toBe(`Voici l'article :\n${URL_A}`);
    });
  });

  it("draws nothing for a removal marker", async () => {
    await renderMessage(
      message("bot", [text(`read ${URL_A}`), { kind: "link_preview", url: URL_A, removed: true }]),
    );
    expect(cards()).toHaveLength(0);
    expect(bubbles()).toHaveLength(1);
  });

  it.each([
    "javascript:alert(1)",
    "mailto:someone@example.com",
    "tel:+33123456789",
    "itms-services://?action=download-manifest",
  ])("never makes a %s block clickable", async (url) => {
    await renderMessage(message("user", [text("hello"), card({ url })]));
    expect(cards()).toHaveLength(0);
    expect(container.querySelector("a")).toBeNull();
  });

  it("renders the picture from the thread's artifact, never from a remote URL", async () => {
    await renderMessage(
      message("user", [
        text(`hi ${URL_A}`),
        card({ format: "large", image: { ...IMAGE, artifactId: "art-large" } }),
      ]),
    );

    expect(api.artifactsGet).toHaveBeenCalledWith({ botId: "bot1", artifactId: "art-large" });
    const link = cards()[0]!;
    const images = [...link.querySelectorAll("img")];
    expect(images).toHaveLength(1);
    expect(images[0]!.getAttribute("src")).toBe("blob:preview");
    expect(images[0]!.getAttribute("alt")).toBe("");
    for (const element of [link, ...link.querySelectorAll<HTMLElement>("*")]) {
      expect(element.getAttribute("style") ?? "").not.toMatch(/url\(/i);
      expect(element.getAttribute("src") ?? "").not.toMatch(/^https?:/i);
      expect(element.className.toString()).not.toMatch(/bg-\[url/);
    }
  });

  it("falls back to a tile with the image glyph when the artifact cannot be read", async () => {
    api.artifactsGet.mockRejectedValue(new Error("gone"));
    await renderMessage(
      message("user", [text(`hi ${URL_A}`), card({ image: { ...IMAGE, artifactId: "art-gone" } })]),
    );

    const link = cards()[0]!;
    expect(link.querySelector("img")).toBeNull();
    expect(link.querySelector("svg")).not.toBeNull();
  });

  it("shows a title with markup as plain text", async () => {
    await renderMessage(
      message("user", [text(`hi ${URL_A}`), card({ title: "<img src=x onerror=alert(1)>" })]),
    );
    expect(cards()[0]!.querySelector("img")).toBeNull();
    expect(cards()[0]!.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("Remove preview action", () => {
  const baseProps = {
    onReply: () => undefined,
    onReact: async () => undefined,
    voiceReady: false,
    speaking: false,
    onSpeak: () => undefined,
    previewMessageId: "m1",
  };
  const removeButton = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Remove preview"]');

  it("is in a bot's hover pill after Copy, only when the message has a card", async () => {
    await act(async () =>
      root.render(
        <MessageHoverActions
          message={message("bot", [text(`hi ${URL_A}`), card()])}
          {...baseProps}
        />,
      ),
    );
    const labels = [...container.querySelectorAll("button")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(labels.indexOf("Remove preview")).toBe(labels.indexOf("Copy") + 1);

    await act(async () => removeButton()!.click());
    expect(api.removeLinkPreview).toHaveBeenCalledWith({ messageId: "m1" });

    await act(async () =>
      root.render(
        <MessageHoverActions
          message={message("bot", [
            text(`hi ${URL_A}`),
            { kind: "link_preview", url: URL_A, removed: true },
          ])}
          {...baseProps}
        />,
      ),
    );
    expect(removeButton()).toBeNull();

    await act(async () =>
      root.render(<MessageHoverActions message={message("bot", [text("hi")])} {...baseProps} />),
    );
    expect(removeButton()).toBeNull();
  });

  it("is also under the person's own message, where their links live", async () => {
    await act(async () =>
      root.render(
        <UserMessageActions
          message={message("user", [text(`hi ${URL_A}`), card()])}
          previewMessageId="m1"
          onEdit={() => undefined}
        />,
      ),
    );
    await act(async () => removeButton()!.click());
    expect(api.removeLinkPreview).toHaveBeenCalledWith({ messageId: "m1" });

    await act(async () =>
      root.render(
        <UserMessageActions message={message("user", [text("hi")])} onEdit={() => undefined} />,
      ),
    );
    expect(removeButton()).toBeNull();
  });

  it("leaves the card alone when the server refuses", async () => {
    api.removeLinkPreview.mockRejectedValue(new Error("nope"));
    await act(async () =>
      root.render(
        <UserMessageActions
          message={message("user", [text(`hi ${URL_A}`), card()])}
          previewMessageId="m1"
          onEdit={() => undefined}
        />,
      ),
    );
    await act(async () => removeButton()!.click());
    expect(api.removeLinkPreview).toHaveBeenCalledOnce();
  });
});
