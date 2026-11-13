// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ContextMenuPosition } from "../BotContextMenu";
import { useLongPress } from "./use-long-press";

let opened: ContextMenuPosition[];
let navigations: number;

function Row() {
  const longPress = useLongPress();
  return (
    <button
      type="button"
      onClick={() => navigations++}
      {...longPress((_target, point) => {
        opened.push(point);
        return true;
      })}
    >
      Chief
    </button>
  );
}

let root: Root;
let row: HTMLButtonElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  opened = [];
  navigations = 0;
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => root.render(<Row />));
  row = container.querySelector("button")!;
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

/** Dispatches like a browser and returns false when a handler prevented the default. */
function fire(type: string, init: PointerEventInit = {}) {
  const Event = type.startsWith("pointer") ? PointerEvent : MouseEvent;
  let allowed = true;
  act(() => {
    allowed = row.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
  });
  return allowed;
}

const touch = { pointerType: "touch", pointerId: 1 } as const;

function touchDown(x = 20, y = 30) {
  fire("pointerdown", { ...touch, clientX: x, clientY: y });
}

it("opens the menu at the touch point after a 500 ms hold, and the lifting tap does not navigate", () => {
  touchDown();
  act(() => vi.advanceTimersByTime(499));
  expect(opened).toEqual([]);
  act(() => vi.advanceTimersByTime(1));
  expect(opened).toEqual([{ x: 20, y: 30 }]);

  fire("pointerup", touch);
  fire("click");
  expect(navigations).toBe(0);

  // The next tap is a plain tap again.
  touchDown();
  fire("pointerup", touch);
  fire("click");
  expect(navigations).toBe(1);
  expect(opened).toHaveLength(1);
});

it("opens once when Android also fires contextmenu for the same hold", () => {
  touchDown();
  act(() => vi.advanceTimersByTime(500));
  const native = fire("contextmenu", { clientX: 20, clientY: 30 });
  expect(native).toBe(false);
  expect(opened).toHaveLength(1);

  // Android's contextmenu can also come first: the timer then stays quiet.
  touchDown(40, 50);
  fire("contextmenu", { clientX: 40, clientY: 50 });
  act(() => vi.advanceTimersByTime(1000));
  expect(opened).toEqual([
    { x: 20, y: 30 },
    { x: 40, y: 50 },
  ]);
});

it("cancels the hold when the finger moves past 10 px or the browser takes it for a scroll", () => {
  touchDown(20, 30);
  fire("pointermove", { ...touch, clientX: 20, clientY: 41 });
  act(() => vi.advanceTimersByTime(1000));

  touchDown(20, 30);
  fire("pointercancel", touch);
  act(() => vi.advanceTimersByTime(1000));
  expect(opened).toEqual([]);

  // A mouse never holds: its menu is the right click's.
  fire("pointerdown", { pointerType: "mouse", pointerId: 2, clientX: 5, clientY: 6 });
  act(() => vi.advanceTimersByTime(1000));
  expect(opened).toEqual([]);
  fire("contextmenu", { clientX: 5, clientY: 6 });
  fire("click");
  expect(opened).toEqual([{ x: 5, y: 6 }]);
  expect(navigations).toBe(1);
});
