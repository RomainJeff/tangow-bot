import type { ThinkingLevel } from "@rakazo/contracts";
import type { FieldSaveState } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ rpc: vi.fn() }));

import { modelChoice, modelPatch, thinkingChoice } from "./bot-choices";
import type { BotPageContext, FieldSave } from "./bot-page";

/** A field whose save ends in `after`; `dismiss` returns it to rest, as the store does. */
function field<V>(
  value: V,
  after: FieldSaveState<V>,
  state: FieldSaveState<V> = { kind: "idle" },
): FieldSave<V> {
  let now = state;
  return {
    state,
    value,
    draft: undefined,
    conflict: false,
    save: vi.fn(async () => {
      now = after;
    }),
    current: () => now,
    retry: vi.fn(async () => undefined),
    dismiss: vi.fn(() => {
      now = { kind: "idle" };
    }),
    setDraft: vi.fn(),
  };
}

const PAGE = { readOnly: false } as BotPageContext;
const CATALOG = { credentials: [], catalog: [], me: null };

function choiceFor(model: FieldSave<string>) {
  return modelChoice(PAGE, {
    catalog: CATALOG,
    load: { kind: "ready" },
    model,
    thinking: field<ThinkingLevel | "">("", { kind: "idle" }),
  });
}

describe("a model picked from its list", () => {
  it("checks the current model and goes back without saving when it is picked again", async () => {
    const model = field("anthropic::claude-test", { kind: "idle" });
    const choice = choiceFor(model);
    expect(choice.options.map((option) => option.label)).toEqual(["Space default", "claude-test"]);
    expect(choice.selected?.label).toBe("claude-test");

    expect(await choice.choose("1")).toBe(true);
    expect(model.save).not.toHaveBeenCalled();
  });

  it("saves another model, and stays when the save failed", async () => {
    const model = field("anthropic::claude-test", {
      kind: "failed",
      value: "",
      reason: "No model connected",
      attempt: 1,
    });

    expect(await choiceFor(model).choose("0")).toBe(false);
    expect(vi.mocked(model.save).mock.calls).toEqual([[""]]);
  });

  it("drops a failed save when the current model is picked again, so Retry cannot resend it", async () => {
    const failed: FieldSaveState<string> = {
      kind: "failed",
      value: "",
      reason: "No model connected",
      attempt: 1,
    };
    const model = field("anthropic::claude-test", failed, failed);

    expect(await choiceFor(model).choose("1")).toBe(true);
    expect(model.current()).toEqual({ kind: "idle" });
    expect(model.save).not.toHaveBeenCalled();
  });

  it("clears the old thinking level with any new model, even before the catalog is read", () => {
    expect(modelPatch("")).toEqual({ modelProvider: null, modelId: null, thinkingLevel: null });
    expect(modelPatch("anthropic::claude-test")).toEqual({
      modelProvider: "anthropic",
      modelId: "claude-test",
      thinkingLevel: null,
    });
  });

  it("keeps Space default on a failed catalog read and says so, while Thinking waits for Retry", () => {
    const retry = vi.fn();
    const fields = {
      catalog: null,
      load: { kind: "failed", reason: null, retry },
      model: field("", { kind: "idle" }),
      thinking: field<ThinkingLevel | "">("", { kind: "idle" }),
    } as const;

    const model = modelChoice(PAGE, fields);
    expect(model.options.map((option) => option.label)).toEqual(["Space default"]);
    expect(model.load).toEqual({ kind: "failed", reason: "Could not load model settings", retry });

    const thinking = thinkingChoice(PAGE, fields);
    expect(thinking?.options).toEqual([]);
    expect(thinking?.load).toEqual({ kind: "failed", reason: null, retry });
  });
});
