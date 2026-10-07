// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function identityTag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}
vi.mock("@lingui/core/macro", () => ({ t: identityTag }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: identityTag }),
  Trans: ({ children }: { children?: unknown }) => children,
}));

import { ComputerMaintenanceActions } from "./ComputerMaintenanceActions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function stubViewport(wide: boolean) {
  vi.stubGlobal("matchMedia", () => ({
    matches: wide,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe("ComputerMaintenanceActions Teach a task", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function openMenu(onSelect: () => void, disabled = false) {
    await act(async () => {
      root.render(
        <ComputerMaintenanceActions
          botId="bot-1"
          computer={null}
          onChanged={async () => {}}
          teach={{ disabled, onSelect }}
        />,
      );
    });
    const trigger = container.querySelector<HTMLElement>('[data-testid="computer-more-button"]');
    if (trigger) {
      await act(async () => {
        trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
        trigger.click();
      });
    }
    return trigger;
  }

  function teachItem() {
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "Teach a task",
    );
  }

  it("below sm the menu offers Teach a task and selecting it runs the action", async () => {
    stubViewport(false);
    const onSelect = vi.fn();
    await openMenu(onSelect);
    const item = teachItem();
    expect(item).toBeDefined();
    await act(async () => item?.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("below sm the item is disabled with the button's disabled state", async () => {
    stubViewport(false);
    const onSelect = vi.fn();
    await openMenu(onSelect, true);
    const item = teachItem();
    expect(item?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => item?.click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("from sm up the chrome button is shown, so the menu has nothing to render", async () => {
    stubViewport(true);
    const trigger = await openMenu(vi.fn());
    expect(trigger).toBeNull();
  });
});
