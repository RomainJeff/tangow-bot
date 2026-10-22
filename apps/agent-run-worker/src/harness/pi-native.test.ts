import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GuestRunInput } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HarnessHost } from "../harness.js";
import { piNativeHarness } from "./pi-native.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "rakazo-pi-native-"));
  vi.stubEnv("HOME", dir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const run: GuestRunInput = {
  botId: "bot",
  threadId: "thread",
  prompt: "Reply briefly.",
  instructions: "Be brief.",
  history: [],
  images: [],
  tools: [],
  model: { provider: "openai-compatible", id: "offline-fixture" },
};

it.each([
  ["before it starts", (cancel: AbortController) => cancel.abort()],
  ["while it sets up", (cancel: AbortController) => setImmediate(() => cancel.abort())],
])("makes no model call when the run is cancelled %s", async (_when, cancelRun) => {
  const cancel = new AbortController();
  const requests: unknown[] = [];
  const host: HarnessHost = {
    signal: cancel.signal,
    emit: async () => undefined,
    decide: async () => {
      throw new Error("No frame is decided in this test");
    },
    model: async (body) => {
      requests.push(body);
      return { type: "model.end" };
    },
    callTool: async () => {
      throw new Error("No tool runs in this test");
    },
  };
  cancelRun(cancel);

  await expect(
    piNativeHarness.run(
      {
        worker: { runId: "run", attemptId: "attempt", fence: 1 },
        run,
        cwd: dir,
        skillsDir: path.join(dir, "skills"),
      },
      host,
    ),
  ).rejects.toThrow("cancelled");
  expect(requests).toEqual([]);
});
