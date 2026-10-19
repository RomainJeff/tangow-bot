import { describe, expect, it } from "vitest";
import {
  capabilityWorker,
  createCapabilityKey,
  mintCapability,
  verifyCapability,
} from "./capability.js";

const worker = { runId: "run_a", attemptId: "attempt_a", fence: 2 };
const mintedAt = 1_000_000;
const key = createCapabilityKey();
const token = mintCapability(key, worker, mintedAt);

function withClaims(edit: (claims: Record<string, unknown>) => void) {
  const [prefix, claims, mac] = token.split(".");
  const decoded = JSON.parse(Buffer.from(claims!, "base64url").toString("utf8"));
  edit(decoded);
  return `${prefix}.${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${mac}`;
}

describe("verifyCapability", () => {
  it("accepts the token for the attempt it was minted for until it expires", () => {
    expect(verifyCapability(key, token, worker, mintedAt + 599_999)).toEqual({ ok: true });
    expect(verifyCapability(key, token, worker, mintedAt + 600_000)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it.each([
    ["another run", { ...worker, runId: "run_b" }],
    ["another attempt of the run", { ...worker, attemptId: "attempt_b" }],
    ["a newer fence", { ...worker, fence: 3 }],
  ])("refuses a token presented to %s", (_name, expected) => {
    expect(verifyCapability(key, token, expected, mintedAt)).toEqual({
      ok: false,
      reason: "identity",
    });
  });

  it.each([
    ["claims edited to a newer fence", withClaims((claims) => (claims.fence = 3)), "signature"],
    [
      "claims edited to expire later",
      withClaims((claims) => (claims.expiresAt = 9e15)),
      "signature",
    ],
    [
      "a token from another controller",
      mintCapability(createCapabilityKey(), worker, mintedAt),
      "signature",
    ],
    ["a truncated MAC", token.slice(0, -4), "signature"],
    ["another format", token.replace("rkw1.", "rkw2."), "malformed"],
    ["an extra segment", `${token}.x`, "malformed"],
    ["an oversized token", `rkw1.${"a".repeat(600)}.b`, "malformed"],
  ])("refuses %s", (_name, presented, reason) => {
    expect(verifyCapability(key, presented, worker, mintedAt)).toEqual({ ok: false, reason });
  });
});

describe("capabilityWorker", () => {
  it("reads the identity a token names without the key", () => {
    expect(capabilityWorker(token)).toEqual(worker);
    expect(capabilityWorker("not-a-token")).toBeNull();
  });
});
