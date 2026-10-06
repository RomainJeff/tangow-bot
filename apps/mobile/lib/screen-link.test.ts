import type { ScreenLinkClock, ScreenLinkView } from "@rakazo/core";
import { createScreenLink } from "@rakazo/core";
import type { AppStateStatus } from "react-native";
import type { WebViewMessageEvent } from "react-native-webview";
import { describe, expect, it, vi } from "vitest";
import { screenLinkEffects, screenWebViewProps, trackScreenVisibility } from "./screen-link";

const EMBED = "https://rakazo.example.test/novnc/session/view/1900000000.abc_DEF-123/embed.html";
const PLAIN = "https://rakazo.example.test/novnc/session/view/1900000000.abc_DEF-123/vnc.html";
const SAME_DIRECTORY = "https://rakazo.example.test/novnc/session/view/1900000000.abc_DEF-123/x.js";
const OTHER_DIRECTORY =
  "https://rakazo.example.test/novnc/session/view/1900000000.other/embed.html";
const OTHER_ORIGIN =
  "https://evil.example.test/novnc/session/view/1900000000.abc_DEF-123/embed.html";

const CONNECTED = JSON.stringify({ type: "rakazo-screen-state", version: 1, state: "connected" });
const STALLED = JSON.stringify({ type: "rakazo-screen-state", version: 1, state: "stalled" });

function fakeClock(): ScreenLinkClock & { advance(ms: number): void } {
  let now = 1_000_000;
  let timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  return {
    now: () => now,
    schedule(fn, ms) {
      const timer = { at: now + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    advance(ms) {
      now += ms;
      const due = timers.filter((timer) => timer.live && timer.at <= now);
      timers = timers.filter((timer) => !due.includes(timer));
      for (const timer of due) timer.fn();
    },
  };
}

function setup(screenUrl: string) {
  const clock = fakeClock();
  const onAdjudicate = vi.fn();
  const onReload = vi.fn();
  const views: ScreenLinkView[] = [];
  const link = createScreenLink({
    clock,
    onAdjudicate,
    onReload,
    onView: (view) => views.push(view),
  });
  link.url(screenUrl);
  const props = screenWebViewProps(link, screenUrl);
  const post = (url: string, data: unknown) =>
    props.onMessage({ nativeEvent: { url, data } } as WebViewMessageEvent);
  return { clock, link, props, post, onAdjudicate, onReload, views };
}

describe("screen WebView message gate", () => {
  it("keeps every origin open for Safari-free navigation and decides in the navigation hook", () => {
    expect(setup(EMBED).props.originWhitelist).toEqual(["*"]);
  });

  it("accepts a state from a document inside the screen's capability directory", () => {
    const { post, link } = setup(EMBED);
    post(SAME_DIRECTORY, CONNECTED);
    expect(link.view()).toBe("none");
  });

  it.each([
    ["another origin", OTHER_ORIGIN],
    ["another capability directory", OTHER_DIRECTORY],
    ["a malformed url", "not a url"],
  ])("ignores a state posted from %s", (_name, url) => {
    const { post, link } = setup(EMBED);
    post(url, CONNECTED);
    expect(link.view()).toBe("connecting");
  });

  it("passes malformed data to the controller, which ignores it", () => {
    const { post, link } = setup(EMBED);
    post(EMBED, { type: "rakazo-screen-state", version: 1, state: "connected" });
    post(EMBED, `${CONNECTED}${" ".repeat(300)}`);
    expect(link.view()).toBe("connecting");
  });

  it("asks for a status read when the screen stalls, once per stall", () => {
    const { post, onAdjudicate, onReload } = setup(EMBED);
    post(EMBED, STALLED);
    expect(onAdjudicate).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();
  });
});

describe("screen WebView load and navigation", () => {
  it("shows a plain page as connected once its main frame finished loading", () => {
    const { props, link } = setup(PLAIN);
    expect(link.view()).toBe("connecting");
    props.onLoadEnd();
    expect(link.view()).toBe("none");
  });

  it("allows the screen document, its directory and about:blank only", () => {
    const { props } = setup(EMBED);
    const allowed = (url: string) => props.onShouldStartLoadWithRequest({ url });
    expect(allowed(EMBED)).toBe(true);
    expect(allowed(SAME_DIRECTORY)).toBe(true);
    expect(allowed("about:blank")).toBe(true);
    expect(allowed(OTHER_ORIGIN)).toBe(false);
    expect(allowed(OTHER_DIRECTORY)).toBe(false);
    expect(allowed("https://example.test/")).toBe(false);
    expect(allowed("javascript:alert(1)")).toBe(false);
  });

  it("stops listening to an embed that loads a second document", () => {
    const { props, link } = setup(EMBED);
    props.onLoadEnd();
    props.onLoadEnd();
    expect(link.view()).toBe("none");
  });
});

describe("app visibility", () => {
  function track() {
    const clock = fakeClock();
    const link = { hidden: vi.fn(), returned: vi.fn() };
    let emit: (state: AppStateStatus) => void = () => undefined;
    const unsubscribe = vi.fn();
    const stop = trackScreenVisibility(
      link,
      (listener) => {
        emit = listener;
        return unsubscribe;
      },
      clock.now,
    );
    return { clock, link, emit: (state: AppStateStatus) => emit(state), stop, unsubscribe };
  }

  it("hides on background and reports the time away when the app is active again", () => {
    const { clock, link, emit } = track();
    emit("background");
    clock.advance(12_000);
    emit("active");
    expect(link.hidden).toHaveBeenCalledTimes(1);
    expect(link.returned).toHaveBeenCalledExactlyOnceWith(12_000);
  });

  it("counts the time away from the first non-active state", () => {
    const { clock, link, emit } = track();
    emit("inactive");
    clock.advance(4_000);
    emit("background");
    clock.advance(6_000);
    emit("active");
    expect(link.hidden).toHaveBeenCalledTimes(1);
    expect(link.returned).toHaveBeenCalledExactlyOnceWith(10_000);
  });

  it("ignores an active state when the app was never away", () => {
    const { link, emit } = track();
    emit("active");
    expect(link.hidden).not.toHaveBeenCalled();
    expect(link.returned).not.toHaveBeenCalled();
  });

  it("returns the unsubscribe", () => {
    const { stop, unsubscribe } = track();
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("screen link on return", () => {
  function away(screenUrl: string, ms: number) {
    const fixture = setup(screenUrl);
    const stop = trackScreenVisibility(
      fixture.link,
      (listener) => {
        listener("background");
        fixture.clock.advance(ms);
        listener("active");
        return () => undefined;
      },
      fixture.clock.now,
    );
    return { ...fixture, stop };
  }

  it("reloads a page that does not report its state after 10 seconds away", () => {
    const { onReload } = away(PLAIN, 10_000);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("leaves a page that does not report its state alone after a short absence", () => {
    const { onReload } = away(PLAIN, 3_000);
    expect(onReload).not.toHaveBeenCalled();
  });

  it("gives a talking embed 10 seconds to reconnect before reloading it", () => {
    const fixture = setup(EMBED);
    fixture.post(EMBED, CONNECTED);
    fixture.link.hidden();
    fixture.clock.advance(20_000);
    fixture.link.returned(20_000);
    expect(fixture.onReload).not.toHaveBeenCalled();
    fixture.clock.advance(10_000);
    expect(fixture.onReload).toHaveBeenCalledTimes(1);
  });
});

describe("screen link effects", () => {
  it("adjudicates with a status read that keeps a reusable address", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    screenLinkEffects(refresh).onAdjudicate();
    expect(refresh).toHaveBeenCalledExactlyOnceWith({ force: false });
  });

  it("reloads with a forced read of a new address", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    screenLinkEffects(refresh).onReload();
    expect(refresh).toHaveBeenCalledExactlyOnceWith({ force: true });
  });

  it("swallows a failed refresh", async () => {
    const refresh = vi.fn().mockRejectedValue(new Error("offline"));
    screenLinkEffects(refresh).onReload();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
