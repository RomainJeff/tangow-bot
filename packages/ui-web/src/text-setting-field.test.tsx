// @vitest-environment jsdom
import { createSaveStore, type SaveKey, type SaveStore, saveKey } from "@rakazo/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SaveStoreProvider, useFieldSave } from "./save-store.js";
import { TextSettingField, type TextSettingFieldProps } from "./text-setting-field.js";

const labels = {
  saving: "Saving…",
  saved: "Saved",
  failed: "Could not save",
  retry: "Retry",
  restore: "Restore unsaved text",
};
const key = saveKey({ userId: "u", spaceId: "s" }, "b", "instructions");

type Props = Partial<Omit<TextSettingFieldProps, "field" | "labels">> & {
  store: SaveStore;
  serverValue: string;
  commit: (value: string) => Promise<void>;
  fieldKey?: SaveKey;
};

function Harness({ store, serverValue, commit, fieldKey = key, ...props }: Props) {
  return (
    <SaveStoreProvider store={store}>
      <Field fieldKey={fieldKey} serverValue={serverValue} commit={commit} {...props} />
    </SaveStoreProvider>
  );
}

function Field({
  fieldKey,
  serverValue,
  commit,
  ...props
}: Omit<Props, "store" | "fieldKey"> & { fieldKey: SaveKey }) {
  const field = useFieldSave({ key: fieldKey, serverValue, commit });
  return <TextSettingField label="Instructions" field={field} labels={labels} {...props} />;
}

/** The browser storage a draft must never reach: records every write instead of keeping it. */
function watchedStorage() {
  const writes: string[] = [];
  const storage = {
    get length() {
      return writes.length;
    },
    setItem: (name: string) => void writes.push(name),
    getItem: () => null,
    removeItem: () => {},
    clear: () => {},
    key: () => null,
  };
  return { storage, writes };
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const render = (props: Props) => act(() => root.render(<Harness {...props} />));
const control = () => container.querySelector("textarea, input") as HTMLTextAreaElement;
const meta = () => container.querySelector('[data-slot="save-meta"]')?.textContent ?? "";

function type(element: HTMLElement, value: string) {
  const prototype = Object.getPrototypeOf(element) as object;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const focus = () => act(() => control().focus());
const blur = () => act(() => control().blur());
function press(key: string) {
  let event!: KeyboardEvent;
  act(() => {
    event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    control().dispatchEvent(event);
  });
  return event;
}
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

describe("TextSettingField", () => {
  it("names the control by its label and shows the server value", () => {
    render({ store: createSaveStore(), serverValue: "Be kind.", commit: vi.fn(), multiline: true });
    expect(control().tagName).toBe("TEXTAREA");
    expect(control().value).toBe("Be kind.");
    expect(container.querySelector("label")?.getAttribute("for")).toBe(control().id);
  });

  it("is a single line unless asked otherwise, and sends native props to the control", () => {
    render({
      store: createSaveStore(),
      serverValue: "Maya",
      commit: vi.fn(),
      placeholder: "Name",
      "data-testid": "bot-name",
    } as Props);
    expect(control().tagName).toBe("INPUT");
    expect(control().getAttribute("placeholder")).toBe("Name");
    expect(control().getAttribute("data-testid")).toBe("bot-name");
  });

  it("commits the trimmed text on blur, once, and shows Saved then nothing", async () => {
    const commit = vi.fn(async () => {});
    render({ store: createSaveStore(), serverValue: "Be kind.", commit, multiline: true });

    focus();
    type(control(), "  Be kind and brief.  ");
    expect(commit).not.toHaveBeenCalled();
    blur();
    await settle();

    expect(commit.mock.calls).toEqual([["Be kind and brief."]]);
    expect(meta()).toMatch(/^Saved \d/);
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(meta()).toBe("");
  });

  it("shows the saved text next to Saved before the server value catches up", async () => {
    render({
      store: createSaveStore(),
      serverValue: "Be kind.",
      commit: async () => {},
      multiline: true,
    });
    focus();
    type(control(), "Be kind and brief.");
    blur();
    await settle();
    expect(meta()).toMatch(/^Saved/);
    expect(control().value).toBe("Be kind and brief.");
  });

  it("counts the characters typed against the limit", () => {
    render({
      store: createSaveStore(),
      serverValue: "Be kind.",
      commit: vi.fn(),
      multiline: true,
      counter: true,
      maxLength: 20000,
      locale: "en",
    });
    const count = () => container.querySelector('[data-slot="text-setting-count"]')?.textContent;
    expect(count()).toBe("8 / 20,000");
    focus();
    type(control(), "Be kind, and brief.");
    expect(count()).toBe("19 / 20,000");
  });

  it("styles the control itself and can leave the meta to the caller", () => {
    render({
      store: createSaveStore(),
      serverValue: "Maya",
      commit: vi.fn(),
      controlClassName: "text-title",
      meta: false,
    });
    expect(control().className).toContain("text-title");
    expect(container.querySelector('[data-slot="save-meta"]')).toBeNull();
  });

  it("does not commit when nothing changed once trimmed", async () => {
    const commit = vi.fn(async () => {});
    render({ store: createSaveStore(), serverValue: "Maya", commit });
    focus();
    type(control(), " Maya ");
    blur();
    await settle();
    expect(commit).not.toHaveBeenCalled();
    expect(meta()).toBe("");
  });

  it("puts a required field back when it is emptied, without a call", async () => {
    const commit = vi.fn(async () => {});
    render({ store: createSaveStore(), serverValue: "Maya", commit, required: true });
    focus();
    type(control(), "   ");
    blur();
    await settle();
    expect(commit).not.toHaveBeenCalled();
    expect(control().value).toBe("Maya");
  });

  it("asks before clearing and clears only on a yes", async () => {
    const commit = vi.fn(async () => {});
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render({
      store: createSaveStore(),
      serverValue: "Be kind.",
      commit,
      onConfirmClear: confirm,
    });

    focus();
    type(control(), "");
    blur();
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(control().value).toBe("Be kind.");

    focus();
    type(control(), "");
    blur();
    await settle();
    expect(commit.mock.calls).toEqual([[""]]);
  });

  it("does not ask when the field was already empty", async () => {
    const confirm = vi.fn(async () => true);
    const commit = vi.fn(async () => {});
    render({ store: createSaveStore(), serverValue: "", commit, onConfirmClear: confirm });
    focus();
    type(control(), "x");
    blur();
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(commit.mock.calls).toEqual([["x"]]);
  });

  it("drops the edit on Escape, keeps focus, and has nothing to save on blur", async () => {
    const commit = vi.fn(async () => {});
    render({ store: createSaveStore(), serverValue: "Be kind.", commit, multiline: true });
    focus();
    type(control(), "Be kind and brief.");

    const event = press("Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(control().value).toBe("Be kind.");
    expect(document.activeElement).toBe(control());

    blur();
    await settle();
    expect(commit).not.toHaveBeenCalled();
  });

  it("lets Escape through when there is no edit to drop", () => {
    render({ store: createSaveStore(), serverValue: "Be kind.", commit: vi.fn() });
    focus();
    expect(press("Escape").defaultPrevented).toBe(false);
  });

  it("saves a single line on Enter by leaving the field, but not a multiline one", async () => {
    const commit = vi.fn(async () => {});
    render({ store: createSaveStore(), serverValue: "Maya", commit });
    focus();
    type(control(), "Maya L");
    press("Enter");
    await settle();
    expect(commit.mock.calls).toEqual([["Maya L"]]);

    act(() =>
      root.render(<Harness store={createSaveStore()} serverValue="a" commit={commit} multiline />),
    );
    focus();
    type(control(), "ab");
    press("Enter");
    expect(document.activeElement).toBe(control());
  });

  it("keeps what was typed when the save fails, and Retry sends it again", async () => {
    const commit = vi
      .fn<(value: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce();
    render({ store: createSaveStore(), serverValue: "Be kind.", commit, multiline: true });

    focus();
    type(control(), "Be kind and brief.");
    blur();
    await settle();

    expect(meta()).toBe("Could not save · Retry");
    expect(control().value).toBe("Be kind and brief.");
    expect(control().getAttribute("aria-invalid")).toBe("true");

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-slot="save-meta"] button[data-slot="button"]')
        ?.click(),
    );
    await settle();
    expect(commit.mock.calls).toEqual([["Be kind and brief."], ["Be kind and brief."]]);
    expect(meta()).toMatch(/^Saved/);
  });

  it("clears a failed save once the text is back to the server value, so Retry cannot send it", async () => {
    const commit = vi
      .fn<(value: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue();
    render({ store: createSaveStore(), serverValue: "Be kind.", commit, multiline: true });

    focus();
    type(control(), "Be kind. Added line.");
    blur();
    await settle();
    expect(meta()).toBe("Could not save · Retry");

    focus();
    type(control(), "Be kind.");
    blur();
    await settle();

    expect(control().value).toBe("Be kind.");
    expect(meta()).toBe("");
    expect(control().getAttribute("aria-invalid")).toBeNull();
    expect(commit.mock.calls).toEqual([["Be kind. Added line."]]);
  });

  it("saves from the store after the field unmounted", async () => {
    const store = createSaveStore();
    let finish!: () => void;
    const commit = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render({ store, serverValue: "Be kind.", commit });
    focus();
    type(control(), "Be kind and brief.");
    blur();
    expect(meta()).toBe("Saving…");

    act(() => root.render(<span />));
    finish();
    await settle();
    expect(store.state(key).kind).toBe("saved");
  });

  describe("drafts", () => {
    const base = { serverValue: "Be kind.", commit: vi.fn(async () => {}), keepDraft: true };

    it("survives a close and a reopen in memory, and never touches browser storage", () => {
      const local = watchedStorage();
      const session = watchedStorage();
      vi.stubGlobal("localStorage", local.storage);
      vi.stubGlobal("sessionStorage", session.storage);
      const store = createSaveStore();
      render({ ...base, store });
      focus();
      type(control(), "Be kind and, mostly, brief.");

      act(() => root.render(<span />));
      render({ ...base, store });
      expect(control().value).toBe("Be kind and, mostly, brief.");

      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    });

    it("is gone after the store is reset, as on sign-out", () => {
      const store = createSaveStore();
      render({ ...base, store });
      focus();
      type(control(), "unsaved");
      act(() => root.render(<span />));
      store.reset();
      render({ ...base, store });
      expect(control().value).toBe("Be kind.");
    });

    it("is dropped once typed back to the server value", () => {
      const store = createSaveStore();
      render({ ...base, store });
      focus();
      type(control(), "other");
      type(control(), "Be kind.");
      expect(store.draft(key)).toBeUndefined();
    });

    it("is saved by leaving the field and is not kept afterwards", async () => {
      const store = createSaveStore();
      const commit = vi.fn(async () => {});
      render({ ...base, store, commit });
      focus();
      type(control(), "Be kind and brief.");
      blur();
      await settle();
      expect(commit.mock.calls).toEqual([["Be kind and brief."]]);
      expect(store.draft(key)).toBeUndefined();
    });

    it("shows the server value and offers the draft back when the server moved on", () => {
      const store = createSaveStore();
      render({ ...base, store });
      focus();
      type(control(), "my unsaved words");
      act(() => root.render(<span />));

      render({ ...base, store, serverValue: "Changed by the bot." });
      expect(control().value).toBe("Changed by the bot.");
      const restore = [
        ...container.querySelectorAll<HTMLButtonElement>('button[data-slot="button"]'),
      ].find((button) => button.textContent === "Restore unsaved text");
      expect(restore).toBeDefined();

      act(() => restore?.click());
      expect(control().value).toBe("my unsaved words");
      expect(
        [...container.querySelectorAll("button")].some(
          (b) => b.textContent === "Restore unsaved text",
        ),
      ).toBe(false);
    });

    it("does not take the person's own save in flight for a change made elsewhere", async () => {
      const store = createSaveStore();
      let land!: () => void;
      const commit = vi.fn(() => new Promise<void>((resolve) => (land = resolve)));
      render({ ...base, store, commit });
      focus();
      type(control(), "Be kind and brief.");
      blur();
      focus();
      type(control(), "Be kind and very brief.");

      const offered = () =>
        [...container.querySelectorAll("button")].some(
          (button) => button.textContent === "Restore unsaved text",
        );
      expect(offered()).toBe(false);
      expect(control().value).toBe("Be kind and very brief.");

      await act(async () => land());
      render({ ...base, store, commit, serverValue: "Be kind and brief." });
      expect(offered()).toBe(false);
      expect(control().value).toBe("Be kind and very brief.");
    });

    it("keeps no draft for a field that did not ask for one", () => {
      const store = createSaveStore();
      render({ ...base, store, keepDraft: false });
      focus();
      type(control(), "typed");
      expect(store.draft(key)).toBeUndefined();
    });
  });
});

describe("TextSettingField markup", () => {
  it("renders a labelled wrapper that merges className", () => {
    const html = renderToString(
      <Harness
        store={createSaveStore()}
        serverValue="Maya"
        commit={vi.fn()}
        className="gap-4"
        placeholder="Name"
      />,
    );
    expect(html).toContain('data-slot="text-setting-field"');
    expect(html).toContain("gap-4");
    expect(html).not.toContain("gap-1.5");
    expect(html).toContain('value="Maya"');
    expect(html).toContain('placeholder="Name"');
    expect(html).toContain('aria-live="polite"');
  });
});

describe("useFieldSave", () => {
  it("needs a provider", () => {
    const Bare = () => {
      useFieldSave({ key, serverValue: "", commit: async () => {} });
      return null;
    };
    expect(() => renderToString(<Bare />)).toThrow(/SaveStoreProvider/);
  });
});
