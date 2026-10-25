import { describe, expect, it } from "vitest";
import { createSandboxProvider } from "./sandbox-factory.js";

describe("createSandboxProvider", () => {
  it("returns fake sandbox when explicitly requested", () => {
    const sandbox = createSandboxProvider("fake", {});
    expect(sandbox.describe().id).toBe("fake");
  });

  it("returns the E2B emulator", () => {
    expect(createSandboxProvider("e2b-emulator", {}).describe().id).toBe("e2b-emulator");
  });

  it("refuses E2B without a key", () => {
    expect(() => createSandboxProvider("e2b", {})).toThrow(/E2B_API_KEY/);
  });

  it("throws on unknown provider", () => {
    expect(() => createSandboxProvider("bogus", {})).toThrow(
      'Unknown SANDBOX_PROVIDER "bogus". Use docker | e2b | e2b-emulator | fake.',
    );
  });
});
