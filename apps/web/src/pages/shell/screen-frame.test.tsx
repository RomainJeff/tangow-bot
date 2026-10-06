// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest doesn't run the lingui macro transform: same passthrough as the other web tests.
function identityTag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}
vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: identityTag }) }));

import { ScreenFrame } from "./screen-frame";

const SCREEN_URL = "https://screen.example/novnc/session/control/1.abc_DEF/embed.html";

function state(value: string) {
  return JSON.stringify({ type: "rakazo-screen-state", version: 1, state: value });
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const handlers = { onAdjudicate: vi.fn(), onReload: vi.fn(), onFailed: vi.fn() };

function iframe() {
  const frame = container.querySelector("iframe");
  if (!frame?.contentWindow) throw new Error("no frame");
  return frame;
}

function post(value: string) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { data: state(value), source: iframe().contentWindow }),
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ScreenFrame url={SCREEN_URL} title="Bot screen" allow="" interactive handlers={handlers} />,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("ScreenFrame", () => {
  it("covers a screen that is still connecting and blocks input until it is connected", () => {
    expect(container.querySelector("[role=status]")?.textContent).toBe("Connecting…");
    expect(iframe().style.pointerEvents).toBe("none");

    post("connected");
    expect(container.querySelector("[role=status]")).toBeNull();
    expect(iframe().style.pointerEvents).toBe("auto");
  });

  it("keeps the last frame under a Reconnecting label while the link is down", () => {
    post("connected");
    post("reconnecting");
    expect(container.querySelector("[role=status]")?.textContent).toBe("Reconnecting");
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(iframe().style.pointerEvents).toBe("none");
  });

  it("removes the frame and reports the failure when the link gives up", () => {
    post("reconnecting");
    act(() => {
      vi.advanceTimersByTime(75_000);
    });
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("[role=status]")).toBeNull();
    expect(handlers.onFailed).toHaveBeenCalledTimes(1);
  });
});
