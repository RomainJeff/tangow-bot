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

/** A host that records model requests and supports nothing else. */
function recordingHost(signal: AbortSignal) {
  const requests: unknown[] = [];
  const host: HarnessHost = {
    signal,
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
  return { host, requests };
}

function runPi(host: HarnessHost, input: Partial<Parameters<typeof piNativeHarness.run>[0]> = {}) {
  return piNativeHarness.run(
    {
      worker: { runId: "run", attemptId: "attempt", fence: 1 },
      run,
      cwd: dir,
      skillsDir: path.join(dir, "skills"),
      ...input,
    },
    host,
  );
}

it.each(
  (
    [
      ["before it starts", (cancel: AbortController) => cancel.abort()],
      ["while it sets up", (cancel: AbortController) => setImmediate(() => cancel.abort())],
    ] as const
  ).flatMap(([when, cancelRun]) =>
    ["root", "helper:1"].map((agent) => ({ when, cancelRun, agent })),
  ),
)("makes no model call when $agent is cancelled $when", async ({ cancelRun, agent }) => {
  const cancel = new AbortController();
  const { host, requests } = recordingHost(cancel.signal);
  cancelRun(cancel);

  await expect(runPi(host, { agent })).rejects.toThrow("cancelled");
  expect(requests).toEqual([]);
});

it("relays a ChatGPT subscription model, whose credential only the controller holds", async () => {
  const { host, requests } = recordingHost(new AbortController().signal);

  // The empty relayed reply fails the run afterwards; only reaching the relay matters here.
  await runPi(host, {
    run: { ...run, model: { provider: "openai-codex", id: "gpt-5.6-luna" } },
  }).catch(() => undefined);
  expect(requests).not.toEqual([]);
});
