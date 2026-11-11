import { createComposerLinkPreview, inferComposerChange } from "@tangow/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What `useComposerLinkPreview` does on iOS, without the hook: every change of the field is fed
// with the change `inferComposerChange` reads from the text alone.
function field(read: Parameters<typeof createComposerLinkPreview>[0]["read"]) {
  const controller = createComposerLinkPreview({ read });
  let text = "";
  return {
    controller,
    set(next: string) {
      controller.update(next, inferComposerChange(text, next));
      text = next;
    },
  };
}

describe("iOS composer link preview", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const url = "https://example.com/some/page";

  it("makes no read while the link is typed key by key, and one once a space follows", async () => {
    const read = vi.fn(async () => ({ format: "compact" as const, title: "Page" }));
    const { set } = field(read);
    for (let end = 1; end <= url.length; end++) set(url.slice(0, end));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).not.toHaveBeenCalled();
    set(`${url} `);
    await vi.advanceTimersByTimeAsync(800);
    expect(read).toHaveBeenCalledOnce();
  });

  it("reads a pasted link without waiting for a space, 800 ms later", async () => {
    const read = vi.fn(async () => ({ format: "compact" as const, title: "Page" }));
    const { set, controller } = field(read);
    set("look ");
    set(`look ${url}`);
    await vi.advanceTimersByTimeAsync(799);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getView()).toMatchObject({ status: "ready", site: "example.com" });
  });

  it("never reads a link with a secret, and a removed preview stays removed for the draft", async () => {
    const read = vi.fn(async () => ({ format: "compact" as const, title: "Page" }));
    const { set, controller } = field(read);
    set("https://example.com/p?token=abc123 ");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).not.toHaveBeenCalled();

    set(`${url} `);
    await vi.advanceTimersByTimeAsync(800);
    controller.remove();
    set(`${url} https://other.example/z`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledOnce();
    expect(controller.isRemoved()).toBe(true);

    set("");
    expect(controller.isRemoved()).toBe(false);
  });
});
