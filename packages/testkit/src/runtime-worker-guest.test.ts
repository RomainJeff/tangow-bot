import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GuestTool, LocalToolOutput, WorkerStartV1 } from "@rakazo/adapter-kit";
import {
  createCapabilityKey,
  createSessionInbox,
  encodeMessage,
  type FrameChannel,
  guestModelOf,
  memoryChannelPair,
  mintCapability,
  readGuestFrame,
  verifyCapability,
} from "@rakazo/adapters/runtime-worker";
import { relayPiAiCall } from "@rakazo/adapters/runtime-worker/pi-ai";
import { HARNESSES, runGuest } from "@rakazo/agent-run-worker";
import { afterEach, describe, expect, it } from "vitest";
import { type ModelEmulatorStep, startModelEmulator } from "./model-emulator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const worker = { runId: "run_guest", attemptId: "attempt_guest", fence: 1 };
const FIVE_MIB = 5 * 1024 * 1024;

async function* once(channel: FrameChannel) {
  yield channel;
}

/**
 * Runs the Pi harness in a real guest against a session inbox that grants every guest tool and
 * relays model calls to the emulator. Returns what the controller recorded and the frames it read.
 */
async function driveGuest(options: {
  steps: ModelEmulatorStep[];
  tools: GuestTool[];
  prompt: string;
  cwd: string;
  root?: string;
  spoolDir: string;
}) {
  const server = await startModelEmulator({ steps: options.steps });
  cleanups.push(() => server.close());
  const key = createCapabilityKey();
  const pair = memoryChannelPair();
  const start: WorkerStartV1 = {
    version: 1,
    kind: "worker.start",
    worker,
    workspace: {
      cwd: options.cwd,
      mounts: [{ path: options.cwd, scope: "private", access: "rw" }],
    },
    computer: "none",
    run: {
      botId: "bot_guest",
      threadId: "thread_guest",
      prompt: options.prompt,
      instructions: "Use the tools.",
      history: [],
      images: [],
      tools: options.tools,
      model: guestModelOf(server.model),
    },
  };
  const guestTools = new Set(options.tools.map((tool) => tool.name));
  const recorded: LocalToolOutput[] = [];
  const frames: Array<{ type: string; bytes: number }> = [];
  const inbox = createSessionInbox(worker, async (_seq, body, part) => {
    switch (body.type) {
      case "model.request":
        await relayPiAiCall(
          server.model,
          body.call,
          (event) => part({ type: "model.event", event }),
          {
            signal: new AbortController().signal,
            conversation: { threadId: "thread_guest", botId: "bot_guest" },
          },
        );
        return { type: "model.end" };
      case "tool.call":
        return guestTools.has(body.name)
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
    harness: HARNESSES.pi!,
    spoolDir: options.spoolDir,
    root: options.root,
  });
  await controller;
  server.assertComplete();
  return { exit, recorded, frames };
}

const bashTool: GuestTool = {
  name: "bash",
  description: "Run a shell command",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
  where: "guest",
};

describe("run channel conformance of the Pi harness", () => {
  it("bounds a 5 MiB output for the model and the wire, and keeps it on the guest disk", async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), "rakazo-guest-run-"));
    cleanups.push(() => rm(workdir, { recursive: true, force: true }));

    const { exit, recorded, frames } = await driveGuest({
      prompt: "Print 5 MiB.",
      tools: [bashTool],
      cwd: workdir,
      spoolDir: path.join(workdir, ".spool"),
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
    const output = recorded[0] as Extract<LocalToolOutput, { text: string }>;
    expect(output.text.length).toBeLessThanOrEqual(12_000);
    expect((await stat(output.spoolPath!)).size).toBe(FIVE_MIB);
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

  it("runs a file tool on the guest's volume and shows the model its result object", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-guest-run-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const fileTool = (name: string): GuestTool => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      where: "guest",
    });

    const { exit, recorded } = await driveGuest({
      prompt: "Write then read a note.",
      tools: [fileTool("write_file"), fileTool("read_file")],
      cwd: "/workspace/bots/bot_guest",
      root,
      spoolDir: path.join(root, "spool"),
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "write-1",
            name: "write_file",
            arguments: { path: "note.md", content: "hello\n" },
          },
        },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(result?.content).toBe('{"ok":true,"path":"note.md"}');
          },
          response: {
            type: "tool",
            id: "read-1",
            name: "read_file",
            arguments: { path: "note.md" },
          },
        },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(result?.content).toBe(
              '{"path":"note.md","content":"hello\\n","startLine":1,"endLine":1,"totalLines":1}',
            );
          },
          response: { type: "text", text: "Done." },
        },
      ],
    });

    expect(exit).toBe("done");
    expect(recorded).toEqual([
      { result: { ok: true, path: "note.md" } },
      {
        result: { path: "note.md", content: "hello\n", startLine: 1, endLine: 1, totalLines: 1 },
      },
    ]);
    expect(await readFile(path.join(root, "workspace/bots/bot_guest/note.md"), "utf8")).toBe(
      "hello\n",
    );
  });
});
