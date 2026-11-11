// @vitest-environment jsdom
import { createSaveStore, saveKey } from "@tangow/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SaveStoreProvider, useFieldSave } from "./save-store.js";

const key = saveKey({ userId: "u", spaceId: "s" }, "b", "routine:r1:active");

function Toggle({
  serverValue,
  commit,
}: {
  serverValue: boolean;
  commit: (v: boolean) => Promise<void>;
}) {
  const field = useFieldSave({ key, serverValue, commit });
  return (
    <button type="button" aria-pressed={field.value} onClick={() => field.save(!field.value)}>
      {field.state.kind}
    </button>
  );
}

let container: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => container.remove());

describe("useFieldSave on a switch", () => {
  it("shows the new value while saving and turns back by itself when the save fails", async () => {
    const store = createSaveStore();
    let fail!: (error: Error) => void;
    const commit = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    const root = createRoot(container);
    act(() =>
      root.render(
        <SaveStoreProvider store={store}>
          <Toggle serverValue={false} commit={commit} />
        </SaveStoreProvider>,
      ),
    );
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.getAttribute("aria-pressed")).toBe("false");

    act(() => button.click());
    expect(commit.mock.calls).toEqual([[true]]);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.textContent).toBe("saving");

    await act(async () => fail(new Error("Computer is controlled")));
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.textContent).toBe("failed");
    act(() => root.unmount());
  });

  it("keeps the saved value while the server value has yet to catch up", async () => {
    const store = createSaveStore();
    const root = createRoot(container);
    const render = (serverValue: boolean) =>
      act(() =>
        root.render(
          <SaveStoreProvider store={store}>
            <Toggle serverValue={serverValue} commit={async () => {}} />
          </SaveStoreProvider>,
        ),
      );
    render(false);
    const button = container.querySelector("button") as HTMLButtonElement;
    await act(async () => button.click());
    expect(button.textContent).toBe("saved");
    expect(button.getAttribute("aria-pressed")).toBe("true");

    render(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    act(() => root.unmount());
  });

  it("follows the server value once the save has landed", async () => {
    const store = createSaveStore();
    const root = createRoot(container);
    const render = (serverValue: boolean) =>
      act(() =>
        root.render(
          <SaveStoreProvider store={store}>
            <Toggle serverValue={serverValue} commit={async () => {}} />
          </SaveStoreProvider>,
        ),
      );
    render(false);
    const button = container.querySelector("button") as HTMLButtonElement;
    await act(async () => button.click());
    render(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    act(() => root.unmount());
  });

  it("subscribes once per field, not again on every render", () => {
    const store = createSaveStore();
    const subscribe = store.subscribe;
    let subscriptions = 0;
    store.subscribe = (...args) => {
      subscriptions += 1;
      return subscribe(...args);
    };
    const root = createRoot(container);
    const render = (serverValue: boolean) =>
      act(() =>
        root.render(
          <SaveStoreProvider store={store}>
            <Toggle serverValue={serverValue} commit={async () => {}} />
          </SaveStoreProvider>,
        ),
      );
    render(false);
    render(true);
    render(false);
    expect(subscriptions).toBe(2);
    act(() => root.unmount());
  });
});
