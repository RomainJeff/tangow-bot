import { describe, expect, it } from "vitest";
import { resolveSandboxProvider } from "./sandbox-provider-env.js";

describe("resolveSandboxProvider", () => {
  it("defaults to docker", () => {
    expect(resolveSandboxProvider({})).toBe("docker");
  });

  it("refuses an empty provider and an E2B provider without a key", () => {
    expect(() => resolveSandboxProvider({ SANDBOX_PROVIDER: "" })).toThrow(
      "SANDBOX_PROVIDER is empty. Set it to docker or e2b, or remove it for docker.",
    );
    expect(() => resolveSandboxProvider({ SANDBOX_PROVIDER: "e2b" })).toThrow(
      "SANDBOX_PROVIDER=e2b needs E2B_API_KEY.",
    );
  });

  it("refuses the removed none, daytona and box providers", () => {
    expect(() => resolveSandboxProvider({ SANDBOX_PROVIDER: "none" })).toThrow(
      "The none computer provider was removed. Set SANDBOX_PROVIDER to docker or e2b.",
    );
    expect(() =>
      resolveSandboxProvider({
        SANDBOX_PROVIDER: "daytona",
        DAYTONA_API_KEY: "test-key",
      }),
    ).toThrow("The daytona computer provider was removed. Set SANDBOX_PROVIDER to docker or e2b.");
    expect(() => resolveSandboxProvider({ SANDBOX_PROVIDER: "box" })).toThrow(
      "The box computer provider was removed. Set SANDBOX_PROVIDER to docker or e2b.",
    );
  });

  it("refuses Docker in production without a supervisor token", () => {
    expect(() =>
      resolveSandboxProvider({
        NODE_ENV: "production",
        SANDBOX_PROVIDER: "docker",
      }),
    ).toThrow("SANDBOX_PROVIDER=docker needs SANDBOX_SUPERVISOR_TOKEN in production.");
  });

  it("keeps docker in production when a supervisor token is set", () => {
    expect(
      resolveSandboxProvider({
        NODE_ENV: "production",
        SANDBOX_PROVIDER: "docker",
        SANDBOX_SUPERVISOR_TOKEN: "prod-supervisor-token-with-enough-length",
      }),
    ).toBe("docker");
  });
});
