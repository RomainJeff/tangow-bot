import type { ComputerStatus } from "@tangow/contracts";
import type { HeldScreenUrl } from "@tangow/core";
import { computerScreenKey } from "@tangow/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerScreenResult } from "./computer-screen";
import { cachedScreenUrl, loadComputerScreen } from "./computer-screen";

const running: ComputerStatus = {
  botId: "bot-1",
  mode: "team",
  kind: "fake",
  state: "running",
  controlHolder: "bot",
  controlBotId: "bot-1",
  takeoverRequested: false,
  screenAvailable: true,
  screenWidth: 1280,
  screenHeight: 800,
  homeRevision: null,
  screenStamp: "stamp-1",
  busyBotName: null,
  canUpdate: false,
};

const MINUTE = 60_000;

/** Mirrors the shell: one held URL per bot, one map of in-flight reads, one visible screen. */
function screen(load: () => Promise<{ url: string | null }>) {
  let held: HeldScreenUrl | undefined;
  const reads = new Map<string, Promise<HeldScreenUrl>>();
  const shown: ComputerScreenResult[] = [];
  return {
    shown,
    refresh: (status: ComputerStatus | null, force = false) =>
      loadComputerScreen({
        botId: "bot-1",
        status,
        held,
        force,
        reads,
        load,
        isCurrent: () => true,
        commit: (result, next) => {
          shown.push(result);
          held = next;
        },
        fallbackError: "Could not connect",
      }),
  };
}

function numberedUrls() {
  let calls = 0;
  return vi.fn(async () => ({ url: `https://screen.example/${++calls}` }));
}

describe("computer screen requests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the held URL while the screen key is unchanged", async () => {
    const load = numberedUrls();
    const viewer = screen(load);
    await expect(viewer.refresh(running)).resolves.toBe("https://screen.example/1");
    vi.setSystemTime(10 * MINUTE);
    await expect(viewer.refresh({ ...running, busyBotName: "Chief" })).resolves.toBe(
      "https://screen.example/1",
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect(viewer.shown.at(-1)).toEqual({ url: "https://screen.example/1", error: null });
  });

  it("reads once per change of the screen key", async () => {
    const load = numberedUrls();
    const viewer = screen(load);
    await viewer.refresh(running);
    const leased = { ...running, controlHolder: "user" as const, screenStamp: "stamp-2" };
    await expect(viewer.refresh(leased)).resolves.toBe("https://screen.example/2");
    await expect(viewer.refresh(leased)).resolves.toBe("https://screen.example/2");
    await expect(viewer.refresh({ ...leased, screenStamp: "stamp-3" })).resolves.toBe(
      "https://screen.example/3",
    );
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("holds a read without a screen until the key changes", async () => {
    let url: string | null = null;
    const load = vi.fn(async () => ({ url }));
    const viewer = screen(load);
    await expect(viewer.refresh(running)).resolves.toBeNull();
    url = "https://screen.example/vnc.html";
    await expect(viewer.refresh(running)).resolves.toBeNull();
    await expect(viewer.refresh({ ...running, screenStamp: "stamp-2" })).resolves.toBe(
      "https://screen.example/vnc.html",
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("always reads on a forced refresh", async () => {
    const load = numberedUrls();
    const viewer = screen(load);
    await viewer.refresh(running);
    await expect(viewer.refresh(running, true)).resolves.toBe("https://screen.example/2");
    expect(viewer.shown.at(-1)).toEqual({ url: "https://screen.example/2", error: null });
  });

  it("renews the held URL once it is 50 minutes old", async () => {
    const load = numberedUrls();
    const viewer = screen(load);
    await viewer.refresh(running);
    vi.setSystemTime(50 * MINUTE - 1);
    await expect(viewer.refresh(running)).resolves.toBe("https://screen.example/1");
    vi.setSystemTime(50 * MINUTE);
    await expect(viewer.refresh(running)).resolves.toBe("https://screen.example/2");
  });

  it("reads without a known status", async () => {
    const viewer = screen(numberedUrls());
    await viewer.refresh(null);
    await expect(viewer.refresh(null)).resolves.toBe("https://screen.example/2");
  });

  it("shares a background read in flight for the same key", async () => {
    const pending: Array<(screen: { url: string | null }) => void> = [];
    const load = vi.fn(
      () =>
        new Promise<{ url: string | null }>((resolve) => {
          pending.push(resolve);
        }),
    );
    const viewer = screen(load);
    const first = viewer.refresh(running);
    const second = viewer.refresh(running);
    for (const finish of pending) finish({ url: "https://screen.example/shared" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      "https://screen.example/shared",
      "https://screen.example/shared",
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  describe("failed reads", () => {
    function failingAfterFirst() {
      let calls = 0;
      return vi.fn(async () => {
        calls += 1;
        if (calls > 1) throw new Error("The computer screen is temporarily busy.");
        return { url: "https://screen.example/1" };
      });
    }

    it("keep the held URL on a forced read until it expires", async () => {
      const viewer = screen(failingAfterFirst());
      await viewer.refresh(running);
      vi.setSystemTime(20 * MINUTE);
      await expect(viewer.refresh(running, true)).resolves.toBe("https://screen.example/1");
      expect(viewer.shown).toEqual([{ url: "https://screen.example/1", error: null }]);

      vi.setSystemTime(60 * MINUTE);
      await expect(viewer.refresh(running, true)).resolves.toBeNull();
      expect(viewer.shown.at(-1)).toEqual({
        url: null,
        error: "The computer screen is temporarily busy.",
      });
    });

    it("keep the held URL in the background until it expires", async () => {
      const viewer = screen(failingAfterFirst());
      await viewer.refresh(running);
      vi.setSystemTime(55 * MINUTE);
      await expect(viewer.refresh(running)).resolves.toBe("https://screen.example/1");
      expect(viewer.shown).toEqual([{ url: "https://screen.example/1", error: null }]);

      vi.setSystemTime(60 * MINUTE);
      await expect(viewer.refresh(running)).resolves.toBeNull();
      expect(viewer.shown.at(-1)).toEqual({
        url: null,
        error: "The computer screen is temporarily busy.",
      });
    });

    it("drop the held URL in the background once the key changed", async () => {
      const viewer = screen(failingAfterFirst());
      await viewer.refresh(running);
      await expect(viewer.refresh({ ...running, screenStamp: "stamp-2" })).resolves.toBeNull();
      expect(viewer.shown.at(-1)).toEqual({
        url: null,
        error: "The computer screen is temporarily busy.",
      });
    });

    it("use the visible fallback for errors without a message", async () => {
      const viewer = screen(async () => Promise.reject(null));
      await viewer.refresh(running);
      expect(viewer.shown).toEqual([{ url: null, error: "Could not connect" }]);
    });
  });

  it.each(["success", "failure"])(
    "ignores a stale %s after a newer screen failure",
    async (outcome) => {
      let finish!: (screen: { url: string | null }) => void;
      let fail!: (error: Error) => void;
      const deferred = new Promise<{ url: string | null }>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      let current = 1;
      const commit = vi.fn();
      const request = {
        botId: "bot-1",
        status: running,
        held: undefined,
        force: true,
        reads: new Map<string, Promise<HeldScreenUrl>>(),
        commit,
        fallbackError: "Could not connect",
      };
      const stale = loadComputerScreen({
        ...request,
        load: () => deferred,
        isCurrent: () => current === 1,
      });
      current = 2;
      await loadComputerScreen({
        ...request,
        load: async () => {
          throw new Error("Latest connection failed");
        },
        isCurrent: () => current === 2,
      });
      if (outcome === "success") finish({ url: "https://stale.example/vnc.html" });
      else fail(new Error("Stale connection failed"));
      await expect(stale).resolves.toBeNull();
      expect(commit).toHaveBeenCalledExactlyOnceWith(
        { url: null, error: "Latest connection failed" },
        undefined,
      );
    },
  );
});

describe("cachedScreenUrl", () => {
  const held: HeldScreenUrl = {
    url: "https://screen.example/1",
    key: computerScreenKey(running),
    readAt: 0,
  };

  it("paints the held URL while its key and age still fit", () => {
    expect(cachedScreenUrl(held, running, 49 * MINUTE)).toBe("https://screen.example/1");
  });

  it("paints nothing once the screen key changed", () => {
    expect(cachedScreenUrl(held, { ...running, screenStamp: "stamp-2" }, MINUTE)).toBeNull();
  });

  it("paints nothing once the URL is 50 minutes old", () => {
    expect(cachedScreenUrl(held, running, 50 * MINUTE)).toBeNull();
  });

  it("paints nothing without a held URL, a cached status, or a screen", () => {
    expect(cachedScreenUrl(undefined, running, MINUTE)).toBeNull();
    expect(cachedScreenUrl(held, null, MINUTE)).toBeNull();
    expect(cachedScreenUrl({ ...held, url: null }, running, MINUTE)).toBeNull();
  });
});
