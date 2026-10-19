import { describe, expect, it } from "vitest";
import { parseControllerMessage, parseGuestMessage } from "./worker-protocol.js";

const worker = { runId: "run_1", attemptId: "attempt_1", fence: 2 };
const start = {
  version: 1,
  kind: "worker.start",
  worker,
  workspace: {
    cwd: "/workspace/bots/bot_a",
    mounts: [
      { path: "/workspace/bots/bot_a", scope: "private", access: "rw" },
      { path: "/workspace/shared", scope: "shared", access: "rw" },
    ],
  },
  computer: "none",
};

const event = { version: 1, kind: "worker.event", worker, payload: { seq: 1 } };

describe("parseControllerMessage", () => {
  it("accepts a v1 start message as sent", () => {
    expect(parseControllerMessage(JSON.parse(JSON.stringify(start)))).toEqual({
      ok: true,
      message: start,
    });
  });

  it("refuses an unknown protocol version", () => {
    expect(parseControllerMessage({ version: 2, kind: "worker.cancel", worker })).toEqual({
      ok: false,
      reason: "unsupported_version",
    });
  });

  it.each([
    [
      "a mount naming its volume",
      {
        ...start,
        workspace: {
          cwd: "/workspace/shared",
          mounts: [{ path: "/workspace/shared", scope: "shared", access: "rw", volumeId: "v" }],
        },
      },
    ],
    ["a guest event", event],
    ["a string", "worker.cancel"],
    ["null", null],
  ])("refuses %s as invalid", (_name, json) => {
    expect(parseControllerMessage(json)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("parseGuestMessage", () => {
  it("accepts a v1 event as sent", () => {
    expect(parseGuestMessage(JSON.parse(JSON.stringify(event)))).toEqual({
      ok: true,
      message: event,
    });
  });

  it.each([
    ["an event naming a volume", { ...event, volumeId: "vol_private_b" }],
    ["a start message", start],
    [
      "a status claiming to be active",
      {
        version: 1,
        kind: "worker.status",
        worker,
        state: "ready",
        providerRef: "vm",
        active: true,
      },
    ],
    ["an event without a fence", { ...event, worker: { runId: "r", attemptId: "a" } }],
  ])("refuses %s as invalid", (_name, json) => {
    expect(parseGuestMessage(json)).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses an event of an unknown protocol version", () => {
    expect(parseGuestMessage({ ...event, version: 2 })).toEqual({
      ok: false,
      reason: "unsupported_version",
    });
  });
});
