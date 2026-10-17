import type { LinkPreviewDraft } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerPageHead } from "./composer-link-preview.js";
import {
  acceptPreviewThumbnail,
  COMPOSER_LINK_PREVIEW_DEBOUNCE_MS,
  type ComposerLinkPreviewView,
  composerLinkPreviewTrigger,
  createComposerLinkPreview,
  inferComposerChange,
} from "./composer-link-preview.js";

const THUMB = "data:image/webp;base64,UklGRg==";

describe("composerLinkPreviewTrigger", () => {
  it("waits while a link is being typed", () => {
    expect(
      composerLinkPreviewTrigger("see https://exa", "see https://exam", "type"),
    ).toBeUndefined();
    expect(composerLinkPreviewTrigger("", "https://example.com", "type")).toBeUndefined();
  });

  it("fires when the link is followed by a space or a line break", () => {
    expect(composerLinkPreviewTrigger("https://a.tld", "https://a.tld ", "type")).toBe(
      "https://a.tld",
    );
    expect(composerLinkPreviewTrigger("https://a.tld", "https://a.tld\n", "type")).toBe(
      "https://a.tld",
    );
    expect(composerLinkPreviewTrigger("", "<https://a.tld> and", "type")).toBe("https://a.tld");
    expect(composerLinkPreviewTrigger("", "see https://a.tld. ok", "type")).toBe("https://a.tld");
  });

  it("fires on a paste that brings the link, with nothing after it", () => {
    expect(composerLinkPreviewTrigger("look ", "look https://a.tld/x", "paste")).toBe(
      "https://a.tld/x",
    );
    expect(composerLinkPreviewTrigger("", "https://a.tld/x", "paste")).toBe("https://a.tld/x");
  });

  it("does not fire for a paste of text that holds no part of the first link", () => {
    expect(composerLinkPreviewTrigger("https://a.tld", "https://a.tld some words", "paste")).toBe(
      "https://a.tld",
    );
    expect(composerLinkPreviewTrigger("https://a.tld", "https://a.tldx", "type")).toBeUndefined();
  });

  it("treats a bare www. address like any other link", () => {
    expect(composerLinkPreviewTrigger("www.lemonde.fr", "www.lemonde.fr ", "type")).toBe(
      "https://www.lemonde.fr",
    );
    expect(composerLinkPreviewTrigger("", "www.lemonde.fr", "type")).toBeUndefined();
    expect(composerLinkPreviewTrigger("see ", "see www.lemonde.fr/x", "paste")).toBe(
      "https://www.lemonde.fr/x",
    );
    expect(composerLinkPreviewTrigger("", "www.lemonde.fr/x?token=abc ", "type")).toBeUndefined();
    expect(composerLinkPreviewTrigger("", "www.login.lemonde.fr ", "type")).toBeUndefined();
    expect(composerLinkPreviewTrigger("", "lemonde.fr ", "type")).toBeUndefined();
    expect(composerLinkPreviewTrigger("", "`www.lemonde.fr` ", "type")).toBeUndefined();
  });

  it("never fires for a link with a secret in its query", () => {
    expect(composerLinkPreviewTrigger("", "https://a.tld/x?token=abc ", "type")).toBeUndefined();
    expect(composerLinkPreviewTrigger("", "https://a.tld/x?Sig=abc", "paste")).toBeUndefined();
  });

  it("takes the first eligible link, past a secret or one-shot link (CA 20)", () => {
    expect(
      composerLinkPreviewTrigger("", "https://a.tld/invite/x?token=1 https://b.tld/y ", "type"),
    ).toBe("https://b.tld/y");
  });

  it("never fires for a link to a sign-in page (CA 71)", () => {
    expect(composerLinkPreviewTrigger("", "https://login.a.tld/ ", "type")).toBeUndefined();
    expect(composerLinkPreviewTrigger("", "https://a.tld/sso", "paste")).toBeUndefined();
    expect(composerLinkPreviewTrigger("", "https://a.tld/blog/login-tips ", "type")).toBe(
      "https://a.tld/blog/login-tips",
    );
  });

  it("ignores links in code and links that are not http(s)", () => {
    expect(composerLinkPreviewTrigger("", "`https://a.tld` ", "type")).toBeUndefined();
    expect(composerLinkPreviewTrigger("", "ftp://a.tld/x ", "type")).toBeUndefined();
  });
});

describe("inferComposerChange", () => {
  it("calls a long insertion a paste and single characters typing", () => {
    expect(inferComposerChange("a ", "a https://a.tld/x")).toBe("paste");
    expect(inferComposerChange("a ", "a b")).toBe("type");
    expect(inferComposerChange("https://a.tld", "https://a.tld ")).toBe("type");
  });
});

describe("acceptPreviewThumbnail", () => {
  it("accepts a bounded WebP data URL only", () => {
    expect(acceptPreviewThumbnail(THUMB)).toBe(THUMB);
    expect(acceptPreviewThumbnail("https://cdn.tld/a.webp")).toBeUndefined();
    expect(acceptPreviewThumbnail("http://cdn.tld/a.webp")).toBeUndefined();
    expect(acceptPreviewThumbnail("data:image/png;base64,AAAA")).toBeUndefined();
    expect(acceptPreviewThumbnail("data:image/svg+xml;base64,AAAA")).toBeUndefined();
    expect(acceptPreviewThumbnail('data:image/webp;base64,AA"onerror="x')).toBeUndefined();
    expect(acceptPreviewThumbnail(`data:image/webp;base64,${"A".repeat(70_000)}`)).toBeUndefined();
    expect(acceptPreviewThumbnail(undefined)).toBeUndefined();
  });
});

describe("createComposerLinkPreview", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  type Read = (url: string, signal: AbortSignal) => Promise<LinkPreviewDraft | null>;

  function setup(read: Read = async () => ({ format: "compact", title: "Page" })) {
    const spy = vi.fn(read);
    const controller = createComposerLinkPreview({ read: spy });
    const views: ComposerLinkPreviewView[] = [];
    controller.subscribe(() => views.push(controller.getView()));
    return { controller, spy, views };
  }
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  it("reads nothing while a link is typed, then once it is complete and 800 ms have passed", async () => {
    const { controller, spy } = setup();
    for (const draft of ["h", "https://a", "https://a.tld/pa", "https://a.tld/page"]) {
      controller.update(draft);
      await wait(2_000);
    }
    expect(spy).not.toHaveBeenCalled();
    controller.update("https://a.tld/page ");
    await wait(COMPOSER_LINK_PREVIEW_DEBOUNCE_MS - 1);
    expect(spy).not.toHaveBeenCalled();
    await wait(1);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toBe("https://a.tld/page");
  });

  it("reads after a paste and shows nothing until the card is ready", async () => {
    const { controller, spy, views } = setup(async () => ({
      format: "large",
      title: "  A‮ title ",
      thumbnail: THUMB,
    }));
    controller.update("https://a.tld/page", "paste");
    expect(controller.getView()).toEqual({ status: "idle" });
    await wait(800);
    await flush();
    expect(spy).toHaveBeenCalledOnce();
    expect(views.map((view) => view.status)).toEqual(["ready"]);
    expect(controller.getView()).toEqual({
      status: "ready",
      url: "https://a.tld/page",
      site: "a.tld",
      title: "A title",
      thumbnail: THUMB,
    });
  });

  it("keeps the icon marker of a thumbnail, and only with a thumbnail", async () => {
    const icon = setup(async () => ({
      format: "compact",
      title: "Site",
      thumbnail: THUMB,
      thumbnailFit: "contain",
    }));
    icon.controller.update("https://a.tld/page", "paste");
    await wait(800);
    await flush();
    expect(icon.controller.getView()).toMatchObject({ thumbnail: THUMB, thumbnailFit: "contain" });

    const bare = setup(async () => ({ format: "compact", title: "Site", thumbnailFit: "contain" }));
    bare.controller.update("https://a.tld/page", "paste");
    await wait(800);
    await flush();
    expect(bare.controller.getView()).not.toHaveProperty("thumbnailFit");
  });

  it("drops the pending read when the link changes or goes away", async () => {
    const { controller, spy } = setup();
    controller.update("https://a.tld/1 ");
    await wait(400);
    controller.update("https://a.tld/1x");
    await wait(2_000);
    expect(spy).not.toHaveBeenCalled();
    controller.update("https://a.tld/1 ");
    await wait(400);
    controller.update("gone");
    await wait(2_000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("ignores the answer of a read whose link changed", async () => {
    const resolvers: Array<(value: LinkPreviewDraft | null) => void> = [];
    const signals: AbortSignal[] = [];
    const { controller } = setup(
      (_url, signal) =>
        new Promise((resolve) => {
          signals.push(signal);
          resolvers.push(resolve);
        }),
    );
    controller.update("https://a.tld/1 ");
    await wait(800);
    expect(controller.getView()).toEqual({ status: "idle" });
    controller.update("https://b.tld/2 ");
    expect(signals[0]?.aborted).toBe(true);
    resolvers[0]?.({ format: "compact", title: "Stale" });
    await flush();
    expect(controller.getView()).toEqual({ status: "idle" });
    await wait(800);
    resolvers[1]?.({ format: "compact", title: "Fresh" });
    await flush();
    expect(controller.getView()).toMatchObject({ status: "ready", title: "Fresh", site: "b.tld" });
  });

  it("keeps one read while the text after the link changes", async () => {
    const { controller, spy } = setup();
    controller.update("https://a.tld/1 ");
    await wait(300);
    controller.update("https://a.tld/1 and more");
    await wait(300);
    controller.update("https://a.tld/1 and more words");
    await wait(300);
    expect(spy).toHaveBeenCalledOnce();
  });

  it("keeps the card and its one read while text is typed before the link", async () => {
    const { controller, spy } = setup();
    controller.update("https://a.tld/1", "paste");
    await wait(800);
    await flush();
    expect(controller.getView()).toEqual({
      status: "ready",
      url: "https://a.tld/1",
      site: "a.tld",
      title: "Page",
    });
    for (const draft of ["Hhttps://a.tld/1", "Hihttps://a.tld/1", "Hi https://a.tld/1"]) {
      controller.update(draft);
    }
    await wait(5_000);
    expect(spy).toHaveBeenCalledOnce();
    expect(controller.getView()).toEqual({
      status: "ready",
      url: "https://a.tld/1",
      site: "a.tld",
      title: "Page",
    });
  });

  it("keeps a running read while text is typed before the link, and drops it when the link is edited", async () => {
    const signals: AbortSignal[] = [];
    const { controller } = setup(
      (_url, signal) =>
        new Promise(() => {
          signals.push(signal);
        }),
    );
    controller.update("https://a.tld/1", "paste");
    await wait(800);
    controller.update("H https://a.tld/1");
    expect(signals[0]?.aborted).toBe(false);
    expect(controller.getView()).toEqual({ status: "idle" });
    controller.update("H https://a.tld/12");
    expect(signals[0]?.aborted).toBe(true);
    expect(controller.getView()).toEqual({ status: "idle" });
    await wait(5_000);
    expect(signals).toHaveLength(1);
  });

  it("never reads a link with a secret in its query", async () => {
    const { controller, spy } = setup();
    controller.update("https://a.tld/x?token=abc ");
    await wait(5_000);
    controller.update("https://a.tld/x?code=1", "paste");
    await wait(5_000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows nothing for a null answer, a failure, or a thumbnail that is not allowed", async () => {
    const nothing = setup(async () => null);
    nothing.controller.update("https://a.tld/1 ");
    await wait(800);
    await flush();
    expect(nothing.controller.getView()).toEqual({ status: "idle" });

    const failing = setup(async () => {
      throw new Error("down");
    });
    failing.controller.update("https://a.tld/1 ");
    await wait(800);
    await flush();
    expect(failing.controller.getView()).toEqual({ status: "idle" });

    const remote = setup(async () => ({
      format: "photo",
      thumbnail: "https://cdn.tld/a.webp" as never,
    }));
    remote.controller.update("https://a.tld/1 ");
    await wait(800);
    await flush();
    expect(remote.controller.getView()).toEqual({ status: "idle" });

    const titleOnly = setup(async () => ({
      format: "compact",
      title: "Title",
      thumbnail: "data:image/png;base64,AAAA" as never,
    }));
    titleOnly.controller.update("https://a.tld/1 ");
    await wait(800);
    await flush();
    const view = titleOnly.controller.getView();
    expect(view).toMatchObject({ status: "ready", title: "Title" });
    expect(view).not.toHaveProperty("thumbnail");
  });

  it("does not read again for a link that failed", async () => {
    const { controller, spy } = setup(async () => null);
    controller.update("https://a.tld/1 ");
    await wait(800);
    await flush();
    controller.update("https://a.tld/1 more");
    await wait(5_000);
    expect(spy).toHaveBeenCalledOnce();
  });

  it("removing the preview is for the whole draft until it is emptied or sent", async () => {
    const { controller, spy } = setup();
    controller.update("https://a.tld/1 ");
    await wait(800);
    await flush();
    expect(controller.getView().status).toBe("ready");

    controller.remove();
    expect(controller.getView()).toEqual({ status: "idle" });
    expect(controller.isRemoved()).toBe(true);

    controller.update("https://b.tld/2 ", "paste");
    await wait(5_000);
    expect(spy).toHaveBeenCalledOnce();
    expect(controller.isRemoved()).toBe(true);

    controller.update("");
    expect(controller.isRemoved()).toBe(false);
    controller.update("https://b.tld/2 ");
    await wait(800);
    expect(spy).toHaveBeenCalledTimes(2);

    controller.remove();
    controller.reset();
    expect(controller.isRemoved()).toBe(false);
  });

  it("a draft handed back after a failed send keeps the removal: no read, still sent without a card", async () => {
    const { controller, spy } = setup();
    controller.update("https://a.tld/1 ");
    controller.remove();
    // The send: the flag is read, then the composer is reset.
    expect(controller.isRemoved()).toBe(true);
    controller.reset();
    controller.update("");
    // The send failed: the screen restores the draft and puts the removal back.
    controller.remove();
    controller.update("https://a.tld/1 and more words", "paste");
    await wait(5_000);

    expect(spy).not.toHaveBeenCalled();
    expect(controller.getView()).toEqual({ status: "idle" });
    expect(controller.isRemoved()).toBe(true);
  });

  it("removing a preview whose read is running cancels its read", async () => {
    let signal: AbortSignal | undefined;
    const { controller } = setup((_url, s) => {
      signal = s;
      return new Promise(() => {});
    });
    controller.update("https://a.tld/1 ");
    await wait(800);
    controller.remove();
    expect(signal?.aborted).toBe(true);
    expect(controller.getView()).toEqual({ status: "idle" });
  });

  it("clearing the draft cancels everything", async () => {
    const { controller, spy } = setup();
    controller.update("https://a.tld/1 ");
    await wait(400);
    controller.update("");
    await wait(5_000);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("createComposerLinkPreview: the device reads a page the server was refused (spec 22)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const URL_ = "https://news.example.com/article-title-here";
  const refused: LinkPreviewDraft = { format: "compact", deviceReadable: true };
  const full: LinkPreviewDraft = { format: "compact", title: "The real title", thumbnail: THUMB };
  const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const PAGE = {
    head: "<head><title>The real title</title>",
    contentType: "text/html; charset=utf-8",
  };

  function setup(options: {
    first?: LinkPreviewDraft | null;
    second?: LinkPreviewDraft | null | Error;
    head?: (url: string, signal: AbortSignal) => Promise<ComposerPageHead | null | undefined>;
    withDevice?: boolean;
  }) {
    const read = vi.fn(async (_url: string, _signal: AbortSignal, page?: ComposerPageHead) => {
      if (page === undefined) return options.first === undefined ? refused : options.first;
      if (options.second instanceof Error) throw options.second;
      return options.second === undefined ? full : options.second;
    });
    const readPageHead = vi.fn(options.head ?? (async () => PAGE));
    const controller = createComposerLinkPreview({
      read,
      ...(options.withDevice === false ? {} : { readPageHead }),
    });
    const views: ComposerLinkPreviewView[] = [];
    controller.subscribe(() => views.push(controller.getView()));
    return { controller, read, readPageHead, views };
  }

  it("shows nothing while the device reads the page, asks again with its head and shows the card", async () => {
    const { controller, read, readPageHead, views } = setup({});
    controller.update(`${URL_} `);
    await wait(800);
    await wait(0);

    expect(readPageHead).toHaveBeenCalledOnce();
    expect(readPageHead.mock.calls[0]?.[0]).toBe(URL_);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]?.[2]).toEqual(PAGE);
    expect(views.map((view) => (view.status === "ready" ? view.title : view.status))).toEqual([
      "The real title",
    ]);
    expect(controller.getView()).toMatchObject({ status: "ready", thumbnail: THUMB });
  });

  it("never reads on the device when the server's draft does not say so", async () => {
    for (const first of [{ format: "compact" as const, title: "Readable page" }, null]) {
      const { controller, read, readPageHead } = setup({ first });
      controller.update(`${URL_} `);
      await wait(800);
      await wait(0);
      expect(readPageHead).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledTimes(1);
    }
  });

  it("never reads on the device in a plain browser, which gives it no reader", async () => {
    const { controller, read, readPageHead } = setup({ withDevice: false });
    controller.update(`${URL_} `);
    await wait(800);
    await wait(0);
    expect(readPageHead).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(controller.getView()).toEqual({ status: "idle" });
  });

  it("shows nothing, silently, when the device cannot read the page", async () => {
    for (const head of [
      async () => null,
      async () => ({ head: "" }),
      async () => undefined,
      async () => {
        throw new Error("blocked");
      },
    ]) {
      const { controller, read, views } = setup({ head });
      controller.update(`${URL_} `);
      await wait(800);
      await wait(0);
      expect(read).toHaveBeenCalledTimes(1);
      expect(controller.getView()).toEqual({ status: "idle" });
      expect(views).toEqual([]);
    }
  });

  it("shows nothing when the server refuses the head, or answers with nothing", async () => {
    for (const second of [new Error("503"), null, { format: "compact" as const }]) {
      const { controller } = setup({ second });
      controller.update(`${URL_} `);
      await wait(800);
      await wait(0);
      expect(controller.getView()).toEqual({ status: "idle" });
    }
  });

  it("shows nothing while the device reads and ends on the device's card", async () => {
    let release: (page: ComposerPageHead) => void = () => undefined;
    const { controller } = setup({
      first: { format: "compact", deviceReadable: true },
      head: () => new Promise((resolve) => (release = resolve)),
    });
    controller.update(`${URL_} `);
    await wait(800);
    await wait(0);
    expect(controller.getView()).toEqual({ status: "idle" });
    release(PAGE);
    await wait(0);
    expect(controller.getView()).toMatchObject({ status: "ready", title: "The real title" });
  });

  it("shows nothing when the device cannot read it and the server had no card", async () => {
    const { controller } = setup({
      first: { format: "compact", deviceReadable: true },
      head: async () => null,
    });
    controller.update(`${URL_} `);
    await wait(800);
    await wait(0);
    expect(controller.getView()).toEqual({ status: "idle" });
  });

  it("drops a device read that outlived its link", async () => {
    let release: (page: ComposerPageHead) => void = () => undefined;
    const { controller, read } = setup({
      head: () => new Promise((resolve) => (release = resolve)),
    });
    controller.update(`${URL_} `);
    await wait(800);
    await wait(0);
    controller.update("something else entirely");
    release({ head: "<head><title>Late</title>" });
    await wait(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(controller.getView()).toEqual({ status: "idle" });
  });

  it("does not read again for a draft whose preview was removed", async () => {
    const { controller, readPageHead } = setup({});
    controller.update(`${URL_} `);
    await wait(800);
    await wait(0);
    controller.remove();
    controller.update(`${URL_} and more`);
    await wait(2_000);
    expect(readPageHead).toHaveBeenCalledOnce();
  });
});
