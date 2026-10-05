import { describe, expect, it, vi } from "vitest";
import { createVolumeStore } from "./volume-store";

describe("createVolumeStore", () => {
  it("notifies subscribers of a new level and skips an unchanged one", () => {
    const store = createVolumeStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.set(4);
    store.set(4);
    store.set(null);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.get()).toBeNull();
    unsubscribe();
    store.set(2);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
