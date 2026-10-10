import type { Me } from "@rakazo/contracts";
import type { FieldSaveState } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  space: "space-a",
  defaults: {} as Record<string, Pick<Me, "defaultProvider" | "defaultModel">>,
}));

vi.mock("./api", () => ({
  selectedSpaceId: () => server.space,
  rpc: vi.fn(async (proc: string) => {
    if (proc === "me") return { userId: "user-1", ...server.defaults[server.space] };
    return [];
  }),
}));

import { loadModelCatalog, selectedModelCatalog, shownSave } from "./bot-page";
import { resetBotPage } from "./bot-page-state";

/** What the Model rows show once they open, as `useModelCatalog` reads it on mount. */
async function openModelRows() {
  const read = selectedModelCatalog();
  await read.refresh(loadModelCatalog);
  const state = read.state();
  return state.kind === "ready" ? state.value.me : state.kind;
}

describe("the bot page's model catalog", () => {
  beforeEach(() => {
    resetBotPage();
    server.space = "space-a";
    server.defaults = {
      "space-a": { defaultProvider: "anthropic", defaultModel: "claude-a" },
      "space-b": { defaultProvider: "openai", defaultModel: "gpt-b" },
    };
  });

  it("shows the default of the space switched to, not of the space it first opened in", async () => {
    expect(await openModelRows()).toMatchObject({ defaultModel: "claude-a" });
    server.space = "space-b";
    expect(await openModelRows()).toMatchObject({
      defaultProvider: "openai",
      defaultModel: "gpt-b",
    });
  });
});

describe("the save a shared meta line shows", () => {
  const field = (state: FieldSaveState<unknown>) => ({ state, retry: async () => undefined });
  const saved = (at: number) => field({ kind: "saved", value: null, at, until: at + 3_000 });

  it("shows a failed save over a later one that succeeded", () => {
    const shape = field({ kind: "failed", value: 3, reason: "Too fast", attempt: 1 });
    expect(shownSave([saved(2_000), shape])?.state).toEqual({
      kind: "failed",
      value: 3,
      reason: "Too fast",
      attempt: 1,
    });
  });

  it("shows a save in flight, else the latest that succeeded", () => {
    const saving = field({ kind: "saving", value: 1, attempt: 1 });
    expect(shownSave([saved(2_000), saving])?.state.kind).toBe("saving");
    expect(shownSave([saved(1_000), saved(2_000)])?.state).toEqual({
      kind: "saved",
      value: null,
      at: 2_000,
      until: 5_000,
    });
  });
});
