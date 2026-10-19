import { describe, expect, it } from "vitest";
import { parseWorkerMessage } from "./worker-protocol.js";

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

describe("parseWorkerMessage", () => {
  it("accepts a v1 start message as sent", () => {
    expect(parseWorkerMessage(JSON.parse(JSON.stringify(start)))).toEqual({
      ok: true,
      message: start,
    });
  });

  it("refuses an unknown protocol version", () => {
    expect(parseWorkerMessage({ version: 2, kind: "worker.cancel", worker })).toEqual({
      ok: false,
      reason: "unsupported_version",
    });
  });

  it.each([
    [
      "a guest event naming a volume",
      { version: 1, kind: "worker.event", worker, payload: {}, volumeId: "vol_private_b" },
    ],
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
    ["a status without a fence", { version: 1, kind: "worker.status", worker: { runId: "r" } }],
    ["a string", "worker.cancel"],
    ["null", null],
  ])("refuses %s as invalid", (_name, json) => {
    expect(parseWorkerMessage(json)).toEqual({ ok: false, reason: "invalid" });
  });
});
