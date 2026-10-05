// @vitest-environment jsdom

import type { LinkPreviewDraft } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
vi.mock("./message-view", () => ({ previewMessageText: () => "" }));
vi.mock("../../lib/dictation.js", () => ({
  dictation: { state: { status: "idle", transcript: "" }, subscribe: () => () => {} },
  webSpeechAvailable: () => false,
}));
vi.mock("../../lib/desktop.js", () => ({ desktopBridge: () => undefined }));

import { Composer } from "./composer.js";

const THUMB = "data:image/webp;base64,UklGRg==";
const PAGE = "https://example.com/article";

type Preview = (url: string, signal: AbortSignal) => Promise<LinkPreviewDraft | null>;

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    activeName: "Maya",
    running: false,
    pendingAttachments: [],
    attachmentNotice: null,
    sendError: null,
    runError: null,
    runErrorId: null,
    onRunErrorPresented: () => {},
    onDismissError: () => {},
    sending: false,
    fileInputRef: { current: null },
    onAttachmentPick: () => {},
    onRemoveAttachment: () => {},
    onSend: async () => {},
    onStop: async () => {},
    mentionTargets: [],
    agentSkills: [],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function mount(overrides: Record<string, unknown> = {}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const props = baseProps(overrides) as unknown as ComponentProps<typeof Composer>;
  act(() => {
    root.render(<Composer {...props} />);
  });
}

function textarea(): HTMLTextAreaElement {
  const el = container.querySelector<HTMLTextAreaElement>('textarea[name="chat-message"]');
  if (!el) throw new Error("composer textarea not found");
  return el;
}

function edit(value: string, inputType = "insertText") {
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setValue?.call(textarea(), value);
    textarea().dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
  });
}

const paste = (value: string) => edit(value, "insertFromPaste");
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const card = () => container.querySelector('[data-slot="composer-link-preview"]');
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Composer link preview", () => {
  it("makes no call while a link is being typed, then reads it once a space follows", async () => {
    const previewLink = vi.fn<Preview>(async () => ({ format: "compact", title: "Page" }));
    mount({ previewLink });
    for (let end = 1; end <= PAGE.length; end++) edit(PAGE.slice(0, end));
    await wait(3_000);
    expect(previewLink).not.toHaveBeenCalled();
    expect(card()).toBeNull();

    edit(`${PAGE} `);
    await wait(799);
    expect(previewLink).not.toHaveBeenCalled();
    await wait(1);
    expect(previewLink).toHaveBeenCalledOnce();
    expect(previewLink.mock.calls[0]?.[0]).toBe(PAGE);
  });

  it("reads a pasted link after the debounce and shows a loading card, then the card", async () => {
    let resolve: (draft: LinkPreviewDraft | null) => void = () => {};
    const previewLink = vi.fn<Preview>(() => new Promise((r) => (resolve = r)));
    mount({ previewLink });
    paste(PAGE);
    await wait(799);
    expect(previewLink).not.toHaveBeenCalled();
    await wait(1);
    expect(previewLink).toHaveBeenCalledOnce();
    expect(card()?.getAttribute("data-state")).toBe("loading");
    expect(button("Remove preview")).toBeTruthy();

    await act(async () => resolve({ format: "large", title: "A page", thumbnail: THUMB }));
    expect(card()?.getAttribute("data-state")).toBe("ready");
    expect(card()?.textContent).toContain("A page");
    expect(card()?.textContent).toContain("example.com");
    expect(card()?.querySelector("img")?.getAttribute("src")).toBe(THUMB);
  });

  it("ignores the answer for a link that has since changed", async () => {
    const resolvers: Array<(draft: LinkPreviewDraft | null) => void> = [];
    const previewLink = vi.fn<Preview>(() => new Promise((r) => resolvers.push(r)));
    mount({ previewLink });
    paste("https://first.example/a");
    await wait(800);
    paste("https://second.example/b");
    await wait(800);
    expect(previewLink).toHaveBeenCalledTimes(2);

    await act(async () => resolvers[0]?.({ format: "compact", title: "Stale" }));
    expect(card()?.textContent ?? "").not.toContain("Stale");
    await act(async () => resolvers[1]?.({ format: "compact", title: "Fresh" }));
    expect(card()?.textContent).toContain("Fresh");
    expect(card()?.textContent).toContain("second.example");
  });

  it("never requests a link whose query holds a secret", async () => {
    const previewLink = vi.fn<Preview>(async () => ({ format: "compact", title: "Page" }));
    mount({ previewLink });
    paste("https://example.com/reset?token=abc123");
    await wait(5_000);
    edit("https://example.com/x?key=1 ");
    await wait(5_000);
    expect(previewLink).not.toHaveBeenCalled();
    expect(card()).toBeNull();
  });

  it("draws no image for a thumbnail that is not an inline WebP, and no remote image ever", async () => {
    const previewLink = vi.fn<Preview>(async () => ({
      format: "large",
      title: "Page",
      thumbnail: "https://cdn.example/thumb.webp" as never,
    }));
    mount({ previewLink });
    paste(PAGE);
    await wait(800);
    expect(card()?.textContent).toContain("Page");
    expect(container.querySelector("img")).toBeNull();
    const html = card()?.innerHTML ?? "";
    expect(html).not.toContain("cdn.example");
    expect(html).not.toMatch(/\b(?:src|srcset|href)=/);
    expect(html).not.toContain("background-image");
  });

  it("shows nothing when the preview is null or fails", async () => {
    const previewLink = vi.fn<Preview>(async () => null);
    mount({ previewLink });
    paste(PAGE);
    await wait(800);
    expect(previewLink).toHaveBeenCalledOnce();
    expect(card()).toBeNull();
  });

  it("sends with linkPreview: false once the preview was removed, even for another link", async () => {
    const previewLink = vi.fn<Preview>(async () => ({ format: "compact", title: "Page" }));
    const onSend = vi.fn(async () => {});
    mount({ previewLink, onSend });
    paste(PAGE);
    await wait(800);
    expect(card()?.getAttribute("data-state")).toBe("ready");

    act(() => button("Remove preview")?.click());
    expect(card()).toBeNull();
    paste(`${PAGE} and https://other.example/z`);
    edit("https://other.example/z ");
    await wait(5_000);
    expect(previewLink).toHaveBeenCalledOnce();

    act(() => button("Send")?.click());
    expect(onSend).toHaveBeenCalledWith("https://other.example/z", [], { linkPreview: false });
  });

  it("sends a message with a visible preview as usual, and starts clean afterwards", async () => {
    const previewLink = vi.fn<Preview>(async () => ({ format: "compact", title: "Page" }));
    const onSend = vi.fn(async () => {});
    mount({ previewLink, onSend });
    paste(PAGE);
    await wait(800);
    expect(card()).toBeTruthy();

    act(() => button("Send")?.click());
    expect(onSend).toHaveBeenCalledWith(PAGE, [], undefined);
    expect(card()).toBeNull();

    // The next draft gets its own preview, and a removal did not carry over.
    paste("https://next.example/n");
    await wait(800);
    expect(previewLink).toHaveBeenCalledTimes(2);
    expect(card()).toBeTruthy();
  });

  it("a retried edit keeps the removed preview: no read, and the message still goes without a card", async () => {
    const previewLink = vi.fn<Preview>(async () => ({ format: "compact", title: "Page" }));
    const onSend = vi.fn(async () => {});
    mount({
      previewLink,
      onSend,
      rewindDraft: { key: "retry:1", text: `${PAGE} `, linkPreviewRemoved: true },
    });
    await wait(5_000);
    expect(textarea().value).toBe(`${PAGE} `);
    expect(previewLink).not.toHaveBeenCalled();
    expect(card()).toBeNull();

    act(() => button("Send")?.click());
    expect(onSend).toHaveBeenCalledWith(PAGE, [], { linkPreview: false });
  });

  it("clearing the draft drops the preview and a pending read", async () => {
    const previewLink = vi.fn<Preview>(async () => ({ format: "compact", title: "Page" }));
    mount({ previewLink });
    paste(PAGE);
    await wait(400);
    edit("");
    await wait(5_000);
    expect(previewLink).not.toHaveBeenCalled();

    paste(PAGE);
    await wait(800);
    expect(card()).toBeTruthy();
    edit("");
    expect(card()).toBeNull();
  });
});
