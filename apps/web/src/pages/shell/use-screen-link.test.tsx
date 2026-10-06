// @vitest-environment jsdom

import { act, useRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenLinkHandlers } from "./use-screen-link";
import { useScreenLink } from "./use-screen-link";

const EMBED_URL = "https://screen.example/novnc/session/view/1.abc_DEF/embed.html";
const PLAIN_URL = "https://screen.example/vnc.html";

const connected = JSON.stringify({ type: "rakazo-screen-state", version: 1, state: "connected" });
const reconnecting = JSON.stringify({
  type: "rakazo-screen-state",
  version: 1,
  state: "reconnecting",
});
const stalled = JSON.stringify({ type: "rakazo-screen-state", version: 1, state: "stalled" });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let handlers: ScreenLinkHandlers;
let visibility: "visible" | "hidden";

function Harness({ url }: { url: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const { view, onLoad } = useScreenLink({ url, frameRef, handlers });
  return (
    <>
      <iframe ref={frameRef} title="screen" src="about:blank" onLoad={onLoad} />
      <output data-view={view} />
    </>
  );
}

function view() {
  return container.querySelector("output")?.getAttribute("data-view");
}

function frame() {
  const iframe = container.querySelector("iframe");
  if (!iframe?.contentWindow) throw new Error("iframe has no window");
  return iframe;
}

function post(data: string, source: MessageEventSource | null) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
  });
}

function setVisibility(next: "visible" | "hidden") {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function mount(url: string) {
  act(() => root.render(<Harness url={url} />));
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  handlers = { onAdjudicate: vi.fn(), onReload: vi.fn(), onFailed: vi.fn() };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useScreenLink on a page that reports its state", () => {
  it("follows messages from its own frame and ignores any other window", () => {
    mount(EMBED_URL);
    expect(view()).toBe("connecting");

    post(connected, window);
    expect(view()).toBe("connecting");

    post(connected, frame().contentWindow);
    expect(view()).toBe("none");

    post(reconnecting, window);
    expect(view()).toBe("none");

    post(reconnecting, frame().contentWindow);
    expect(view()).toBe("reconnecting");
  });

  it("ignores a message with no source", () => {
    mount(EMBED_URL);
    post(connected, null);
    expect(view()).toBe("connecting");
  });

  it("reads the status when the page reports it stalled", () => {
    mount(EMBED_URL);
    post(stalled, frame().contentWindow);
    expect(handlers.onAdjudicate).toHaveBeenCalledTimes(1);
    expect(handlers.onReload).not.toHaveBeenCalled();
  });

  it("lets a returning page reconnect itself, then reloads it if it stays silent", () => {
    mount(EMBED_URL);
    post(connected, frame().contentWindow);
    setVisibility("hidden");
    vi.advanceTimersByTime(15_000);
    setVisibility("visible");
    expect(handlers.onReload).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);
    expect(handlers.onReload).toHaveBeenCalledTimes(1);
  });
});

describe("useScreenLink when the page never connects", () => {
  it("gives up on a link that stays down", () => {
    mount(EMBED_URL);
    post(reconnecting, frame().contentWindow);
    expect(handlers.onFailed).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(75_000);
    });
    expect(view()).toBe("failed");
    expect(handlers.onFailed).toHaveBeenCalledTimes(1);
  });
});

describe("useScreenLink on a plain page", () => {
  it("ignores messages and shows the connection until the frame loads", () => {
    mount(PLAIN_URL);
    post(connected, frame().contentWindow);
    expect(view()).toBe("connecting");

    act(() => {
      frame().dispatchEvent(new Event("load"));
    });
    expect(view()).toBe("none");
  });

  it("reloads after a long absence and not after a short one", () => {
    mount(PLAIN_URL);
    act(() => {
      frame().dispatchEvent(new Event("load"));
    });

    setVisibility("hidden");
    vi.advanceTimersByTime(9_000);
    setVisibility("visible");
    expect(handlers.onReload).not.toHaveBeenCalled();

    setVisibility("hidden");
    vi.advanceTimersByTime(15_000);
    setVisibility("visible");
    expect(handlers.onReload).toHaveBeenCalledTimes(1);
  });
});

describe("useScreenLink on a new URL", () => {
  it("starts over at connecting", () => {
    mount(EMBED_URL);
    post(connected, frame().contentWindow);
    expect(view()).toBe("none");

    mount("https://screen.example/novnc/session/view/2.xyz/embed.html");
    expect(view()).toBe("connecting");
  });
});
