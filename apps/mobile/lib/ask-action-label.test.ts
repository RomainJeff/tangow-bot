import { describe, expect, it } from "vitest";
import { askActionLabel } from "./ask-action-label";

const shout = (message: string) => message.toUpperCase();

describe("askActionLabel", () => {
  it("translates the server label on an outcome card, not the approval id", () => {
    expect(askActionLabel({ id: "allow", label: "Create space", outcome: "created" }, shout)).toBe(
      "CREATE SPACE",
    );
    expect(askActionLabel({ id: "allow", label: "Create bot", outcome: "created" }, shout)).toBe(
      "CREATE BOT",
    );
    expect(askActionLabel({ id: "deny", label: "Cancel", outcome: "cancelled" }, shout)).toBe(
      "CANCEL",
    );
    expect(
      askActionLabel({ id: "allow", label: "Create routine", outcome: "created" }, shout),
    ).toBe("CREATE ROUTINE");
    expect(askActionLabel({ id: "deny", label: "Not now", outcome: "cancelled" }, shout)).toBe(
      "NOT NOW",
    );
  });

  it("shows an unknown server label on an outcome card as sent", () => {
    expect(askActionLabel({ id: "allow", label: "Do it", outcome: "created" }, shout)).toBe(
      "Do it",
    );
  });

  it("keeps the id mapping when the action has no outcome", () => {
    expect(askActionLabel({ id: "allow", label: "Allow once" }, shout)).toBe("ALLOW ONCE");
    expect(askActionLabel({ id: "always", label: "x" }, shout)).toBe("ALWAYS ALLOW THIS TOOL");
    expect(askActionLabel({ id: "deny", label: "x" }, shout)).toBe("DENY");
    expect(askActionLabel({ id: "berlin", label: "Berlin" }, shout)).toBe("Berlin");
  });
});
