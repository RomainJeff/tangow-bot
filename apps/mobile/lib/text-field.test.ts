import { createSaveStore, fieldValue, saveKey } from "@tangow/core";
import { describe, expect, it } from "vitest";
import { leaveTextField, restingText } from "./text-field";

/** A bot name saved through the real store, the way the hero wires it. */
function nameField(serverValue: string) {
  const store = createSaveStore();
  const key = saveKey({ userId: "user-1", spaceId: "space-1" }, "bot-1", "name");
  const sent: string[] = [];
  let online = false;
  const commit = async (value: string) => {
    sent.push(value);
    if (!online) throw new Error("offline");
  };
  const field = () => {
    const state = store.state<string>(key);
    return {
      state,
      value: fieldValue(state, serverValue),
      save: (value: string) => store.save(key, value, commit),
      dismiss: () => store.dismiss(key),
    };
  };
  return {
    field,
    sent,
    retry: async () => {
      online = true;
      await store.retry(key);
    },
  };
}

describe("a name edited in place", () => {
  it("keeps the typed text on screen after a failed save, and Retry sends that text", async () => {
    const name = nameField("Scout");
    leaveTextField(name.field(), "Scout 2 ", { required: true });
    await Promise.resolve();
    expect(name.field().state.kind).toBe("failed");
    expect(restingText(name.field())).toBe("Scout 2");
    await name.retry();
    expect(name.sent).toEqual(["Scout 2", "Scout 2"]);
  });

  it("forgets the failed save when the text goes back to the server name, so Retry sends nothing", async () => {
    const name = nameField("Scout");
    leaveTextField(name.field(), "Scout 2", { required: true });
    await Promise.resolve();
    leaveTextField(name.field(), "Scout", { required: true });
    expect(name.field().state.kind).toBe("idle");
    expect(restingText(name.field())).toBe("Scout");
    await name.retry();
    expect(name.sent).toEqual(["Scout 2"]);
  });

  it("sends nothing when the field is left untouched while a save has failed", async () => {
    const name = nameField("Scout");
    leaveTextField(name.field(), "Scout 2", { required: true });
    await Promise.resolve();
    leaveTextField(name.field(), restingText(name.field()), { required: true });
    expect(name.sent).toEqual(["Scout 2"]);
    expect(name.field().state.kind).toBe("failed");
  });

  it("puts the old name back when emptied, without a call", () => {
    const name = nameField("Scout");
    leaveTextField(name.field(), "  ", { required: true });
    expect(name.sent).toEqual([]);
    expect(restingText(name.field())).toBe("Scout");
  });
});
