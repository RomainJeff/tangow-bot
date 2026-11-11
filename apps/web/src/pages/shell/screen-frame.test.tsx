// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest doesn't run the lingui macro transform: same passthrough as the other web tests.
function identityTag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}
vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: identityTag }) }));

import type { ScreenLinkHandlers } from "./screen-frame";
import { ScreenFrame } from "./screen-frame";

const EMBED_URL = "https://screen.example/novnc/session/control/1.abc_DEF/embed.html";
const PLAIN_URL = "https://screen.example/vnc.html";

function state(value: string) {
  return JSON.stringify({ type: "tangow-screen-state", version: 1, state: value });
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let handlers: {
  onAdjudicate: Mock<ScreenLinkHandlers["onAdjudicate"]>;
  onReload: Mock<ScreenLinkHandlers["onReload"]>;
  onFailed: Mock<ScreenLinkHandlers["onFailed"]>;
};
let visibility: "visible" | "hidden";

function mount(url: string) {
  act(() =>
    root.render(
      <ScreenFrame url={url} title="Bot screen" allow="" interactive handlers={handlers} />,
    ),
  );
}

function iframe() {
  const frame = container.querySelector("iframe");
  if (!frame?.contentWindow) throw new Error("no frame");
  return frame;
}

function label() {
  return container.querySelector("[role=status]")?.textContent ?? null;
}

function post(value: string, source: MessageEventSource | null = iframe().contentWindow) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: state(value), source }));
  });
}

function load() {
  act(() => {
    iframe().dispatchEvent(new Event("load"));
  });
}

function hideFor(ms: number) {
  visibility = "hidden";
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  vi.advanceTimersByTime(ms);
  visibility = "visible";
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  handlers = {
    onAdjudicate: vi.fn<ScreenLinkHandlers["onAdjudicate"]>(),
    onReload: vi.fn<ScreenLinkHandlers["onReload"]>(),
    onFailed: vi.fn<ScreenLinkHandlers["onFailed"]>(),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("ScreenFrame on a page that reports its state", () => {
  it("covers the screen and blocks input until its own frame says it is connected", () => {
    mount(EMBED_URL);
    expect(label()).toBe("Connecting…");
    expect(iframe().style.pointerEvents).toBe("none");

    post("connected", window);
    post("connected", null);
    expect(label()).toBe("Connecting…");

    post("connected");
    expect(label()).toBeNull();
    expect(iframe().style.pointerEvents).toBe("auto");
  });

  it("keeps the last frame under a Reconnecting label while the link is down", () => {
    mount(EMBED_URL);
    post("connected");
    post("reconnecting", window);
    expect(label()).toBeNull();

    post("reconnecting");
    expect(label()).toBe("Reconnecting");
    expect(iframe().style.pointerEvents).toBe("none");
  });

  it("reads the status when the page reports it stalled", () => {
    mount(EMBED_URL);
    post("stalled");
    expect(handlers.onAdjudicate).toHaveBeenCalledTimes(1);
    expect(handlers.onReload).toHaveBeenCalledTimes(0);
  });

  it("lets a returning page reconnect itself, then reloads it if it stays silent", () => {
    mount(EMBED_URL);
    post("connected");
    hideFor(15_000);
    expect(handlers.onReload).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(10_000);
    expect(handlers.onReload).toHaveBeenCalledTimes(1);
  });

  it("removes the frame and reports the failed URL when the link gives up", () => {
    mount(EMBED_URL);
    post("reconnecting");
    act(() => {
      vi.advanceTimersByTime(75_000);
    });
    expect(container.querySelector("iframe")).toBeNull();
    expect(label()).toBeNull();
    expect(handlers.onFailed.mock.calls).toEqual([[EMBED_URL]]);
  });

  it("starts over at Connecting… on a new URL", () => {
    mount(EMBED_URL);
    post("connected");
    mount("https://screen.example/novnc/session/view/2.xyz/embed.html");
    expect(label()).toBe("Connecting…");
  });
});

describe("ScreenFrame on a plain page", () => {
  it("ignores messages and shows the connection until the frame loads", () => {
    mount(PLAIN_URL);
    post("connected");
    expect(label()).toBe("Connecting…");

    load();
    expect(label()).toBeNull();
  });

  it("reloads after a long absence and not after a short one", () => {
    mount(PLAIN_URL);
    load();
    hideFor(9_000);
    expect(handlers.onReload).toHaveBeenCalledTimes(0);

    hideFor(15_000);
    expect(handlers.onReload).toHaveBeenCalledTimes(1);
  });
});
