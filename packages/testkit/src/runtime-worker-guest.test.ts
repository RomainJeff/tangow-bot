import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LocalToolOutput, WorkerStartV1 } from "@rakazo/adapter-kit";
import {
  createCapabilityKey,
  createSessionInbox,
  encodeMessage,
  type FrameChannel,
  guestModelOf,
  memoryChannelPair,
  mintCapability,
  readGuestFrame,
  relayModelRequest,
  verifyCapability,
} from "@rakazo/adapters/runtime-worker";
import { runGuest } from "@rakazo/agent-run-worker";
import { afterEach, describe, expect, it } from "vitest";
import { startModelEmulator } from "./model-emulator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const worker = { runId: "run_guest", attemptId: "attempt_guest", fence: 1 };
const FIVE_MIB = 5 * 1024 * 1024;

async function* once(channel: FrameChannel) {
  yield channel;
}

describe("a guest run with a local bash call", () => {
  it("bounds a 5 MiB output for the model and the wire, and keeps it on the guest disk", async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), "rakazo-guest-run-"));
    cleanups.push(() => rm(workdir, { recursive: true, force: true }));
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "bash-1",
            name: "bash",
            arguments: { command: `yes 'rakazo guest output' | head -c ${FIVE_MIB}` },
          },
        },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            const content = String(result?.content);
            expect(content.length).toBeLessThanOrEqual(12_000);
            expect(content).toContain(`[output truncated: ${FIVE_MIB} bytes in total`);
            expect(content.endsWith("rakazo guest output")).toBe(true);
          },
          response: { type: "text", text: "Printed 5 MiB." },
        },
      ],
    });
    cleanups.push(() => server.close());

    const key = createCapabilityKey();
    const pair = memoryChannelPair();
    const start: WorkerStartV1 = {
      version: 1,
      kind: "worker.start",
      worker,
      workspace: { cwd: workdir, mounts: [] },
      computer: "none",
      run: {
        botId: "bot_guest",
        threadId: "thread_guest",
        prompt: "Print 5 MiB.",
        instructions: "Use bash.",
        history: [],
        images: [],
        tools: [
          {
            name: "bash",
            description: "Run a shell command",
            inputSchema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
            where: "guest",
          },
        ],
        model: guestModelOf(server.model),
      },
    };
    const recorded: LocalToolOutput[] = [];
    const frames: Array<{ type: string; bytes: number }> = [];
    const inbox = createSessionInbox(worker, async (_seq, body, part) => {
      switch (body.type) {
        case "model.request":
          await relayModelRequest(server.model, body, (event) =>
            part({ type: "model.event", event }),
          );
          return { type: "model.end" };
        case "tool.call":
          return body.name === "bash"
            ? { type: "tool.grant" }
            : { type: "refused", reason: "unknown_tool" };
        case "steering.claim":
          return { type: "steering", messages: [] };
        case "tool.done":
          recorded.push(body.output);
          return { type: "tool.recorded" };
        case "done":
          return { type: "stop", reason: "done" };
        default:
          return { type: "ack" };
      }
    });
    inbox.attach((reply) => void pair.controller.send(encodeMessage(reply)));
    const controller = (async () => {
      for await (const frame of pair.controller.frames) {
        const read = readGuestFrame(frame);
        if (!read.ok) throw new Error(`refused frame: ${read.reason}`);
        if (read.message.kind === "worker.hello") {
          expect(verifyCapability(key, read.message.capability, worker, Date.now())).toEqual({
            ok: true,
          });
          await pair.controller.send(encodeMessage(start));
          continue;
        }
        frames.push({ type: read.message.payload.body.type, bytes: frame.byteLength });
        expect(inbox.accept(read.message)).toEqual({ ok: true });
      }
    })();

    const exit = await runGuest({
      channels: once(pair.guest),
      capability: mintCapability(key, worker, Date.now()),
      spoolDir: path.join(workdir, ".spool"),
    });
    await controller;

    server.assertComplete();
    expect(exit).toBe("done");
    expect(recorded).toEqual([
      {
        text: expect.stringContaining(`[output truncated: ${FIVE_MIB} bytes in total, it is in `),
        isError: false,
        truncated: true,
        totalBytes: FIVE_MIB,
        spoolPath: expect.stringContaining(path.join(workdir, ".spool")),
      },
    ]);
    expect(recorded[0]!.text.length).toBeLessThanOrEqual(12_000);
    expect((await stat(recorded[0]!.spoolPath!)).size).toBe(FIVE_MIB);
    const toolDone = frames.find((frame) => frame.type === "tool.done");
    expect(toolDone!.bytes).toBeLessThan(1024 * 1024);
    const lifecycle = new Set(["tool", "tool.call", "tool.done", "done"]);
    expect(frames.map((frame) => frame.type).filter((type) => lifecycle.has(type))).toEqual([
      "tool",
      "tool.call",
      "tool.done",
      "done",
    ]);
  });
});
