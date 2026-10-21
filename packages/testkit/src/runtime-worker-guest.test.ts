import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  GuestBody,
  GuestTool,
  LocalToolOutput,
  ReplyFinal,
  WorkerStartV1,
} from "@rakazo/adapter-kit";
import type { FrameChannel } from "@rakazo/adapters/runtime-worker";
import {
  createCapabilityKey,
  createSessionInbox,
  encodeMessage,
  guestModelOf,
  memoryChannelPair,
  mintCapability,
  readGuestFrame,
  verifyCapability,
} from "@rakazo/adapters/runtime-worker";
import { relayPiAiCall } from "@rakazo/adapters/runtime-worker/pi-ai";
import type { GuestHarness } from "@rakazo/agent-run-worker";
import { HARNESSES, runGuest } from "@rakazo/agent-run-worker";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelEmulatorStep } from "./model-emulator.js";
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

/**
 * Runs a harness (Pi by default) in a real guest against a session inbox that grants every guest
 * tool and relays model calls to the emulator, unless `reply` answers a frame first. Returns what
 * the controller recorded and the frames it read.
 */
async function driveGuest(options: {
  steps: ModelEmulatorStep[];
  tools: GuestTool[];
  prompt: string;
  cwd: string;
  root?: string;
  spoolDir: string;
  harness?: GuestHarness;
  reply?: (body: GuestBody) => ReplyFinal | undefined;
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
  const guestTools = new Set(
    options.tools.filter((tool) => tool.where === "guest").map((tool) => tool.name),
  );
  const controllerCalls: string[] = [];
  const recorded: LocalToolOutput[] = [];
  const frames: Array<{ type: string; bytes: number; body: GuestBody }> = [];
  const latencies: Array<{ re: number; firstEventMs: number }> = [];
  const inbox = createSessionInbox(worker, async (_seq, body, part) => {
    const replied = options.reply?.(body);
    if (replied) return replied;
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
        if (guestTools.has(body.name)) return { type: "tool.grant" };
        controllerCalls.push(body.name);
        return { type: "tool.result", output: { controller: body.name } };
      case "steering.claim":
        return { type: "steering", messages: [] };
      case "tool.done":
        recorded.push(body.output);
        return { type: "tool.recorded" };
      case "skills.index":
      case "skills.index.end":
      case "skills.collision":
      case "skills.used":
      case "transcript":
        return { type: "recorded" };
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
      const body = read.message.payload.body;
      frames.push({ type: body.type, bytes: frame.byteLength, body });
      if (body.type === "model.latency") latencies.push(body);
      expect(inbox.accept(read.message)).toEqual({ ok: true });
    }
  })();

  const exit = await runGuest({
    channels: once(pair.guest),
    capability: mintCapability(key, worker, Date.now()),
    harness: options.harness ?? HARNESSES.pi!,
    spoolDir: options.spoolDir,
    root: options.root,
    home: path.join(options.root ?? options.cwd, ".guest-home"),
  });
  await controller;
  server.assertComplete();
  return { exit, recorded, frames, controllerCalls, latencies };
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
  it.each([true, false])(
    "sends instructions once and offers the skills catalog only with read, read=%s",
    async (read) => {
      const root = await mkdtemp(path.join(tmpdir(), "rakazo-prompt-"));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const managed = path.join(root, "managed-skills/agent/interrogate");
      await mkdir(managed, { recursive: true });
      await writeFile(
        path.join(managed, "SKILL.md"),
        "---\nname: Interrogate\ndescription: Review work\n---\nRead the changes.\n",
      );
      const { exit } = await driveGuest({
        cwd: "/workspace/bots/bot_guest",
        root,
        spoolDir: path.join(root, "spool"),
        prompt: "Reply briefly.",
        tools: read
          ? [{ name: "read", description: "Read", inputSchema: { type: "object" }, where: "guest" }]
          : [],
        steps: [
          {
            async expect(request) {
              await writeFile(path.join(root, "model-request.json"), JSON.stringify(request));
              const systems = request.messages.filter((message) => message.role === "system");
              expect(systems).toHaveLength(1);
              const prompt = String(systems[0]?.content);
              if (!read) {
                expect(prompt).not.toContain("<available_skills>");
                expect(prompt).not.toContain("Use the read tool");
              }
              expect(prompt.split("Use the tools.")).toHaveLength(2);
              expect(prompt.split("<available_skills>")).toHaveLength(read ? 2 : 1);
              expect(prompt.split("<name>Interrogate</name>")).toHaveLength(read ? 2 : 1);
            },
            response: { type: "text", text: "Done." },
          },
        ],
      });
      expect(exit).toBe("done");
    },
  );

  it("bounds a 5 MiB output for the model and the wire, and keeps it on the guest disk", async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), "rakazo-guest-run-"));
    cleanups.push(() => rm(workdir, { recursive: true, force: true }));

    const { exit, recorded, frames, latencies } = await driveGuest({
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
    expect(latencies).toHaveLength(2);
    expect(
      latencies.every((sample) => Number.isFinite(sample.firstEventMs) && sample.firstEventMs >= 0),
    ).toBe(true);
    expect(new Set(latencies.map((sample) => sample.re)).size).toBe(2);
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

  it("runs native writes on the mounted root and keeps Rakazo tools on the controller", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-guest-run-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const fileTool = (name: string): GuestTool => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      where: "guest",
    });

    const { exit, recorded, controllerCalls } = await driveGuest({
      prompt: "Write then read a note.",
      tools: [
        fileTool("write"),
        fileTool("read"),
        ...["computer", "message_user"].map((name) => ({
          ...fileTool(name),
          where: "controller" as const,
        })),
      ],
      cwd: "/workspace/bots/bot_guest",
      root,
      spoolDir: path.join(root, "spool"),
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Use the tools.");
          },
          response: {
            type: "tool",
            id: "write-1",
            name: "write",
            arguments: { path: "note.md", content: "hello\n" },
          },
        },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(result?.content).toContain("Successfully wrote");
          },
          response: {
            type: "tool",
            id: "read-1",
            name: "read",
            arguments: { path: "note.md" },
          },
        },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(result?.content).toBe("hello\n");
          },
          response: { type: "tool", id: "computer-1", name: "computer", arguments: {} },
        },
        {
          expect(request) {
            expect(request.messages.findLast((message) => message.role === "tool")?.content).toBe(
              '{"controller":"computer"}',
            );
          },
          response: {
            type: "tool",
            id: "message-1",
            name: "message_user",
            arguments: { message: "Done." },
          },
        },
        {
          expect(request) {
            expect(request.messages.findLast((message) => message.role === "tool")?.content).toBe(
              '{"controller":"message_user"}',
            );
          },
          response: { type: "text", text: "Done." },
        },
      ],
    });

    expect(exit).toBe("done");
    expect(recorded).toHaveLength(2);
    expect(controllerCalls).toEqual(["computer", "message_user"]);
    expect(await readFile(path.join(root, "workspace/bots/bot_guest/note.md"), "utf8")).toBe(
      "hello\n",
    );
  });
  it("bounds and spools a native read result before sending it over P2", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "rakazo-native-read-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    const content = "native-file-\n".repeat(1000);
    await writeFile(path.join(cwd, "large.txt"), content);
    const { recorded, exit } = await driveGuest({
      cwd,
      spoolDir: path.join(cwd, "spool"),
      prompt: "Read large.txt.",
      tools: [
        {
          name: "read",
          description: "Read",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          where: "guest",
        },
      ],
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "large-read",
            name: "read",
            arguments: { path: "large.txt" },
          },
        },
        {
          expect(request) {
            const text = String(
              request.messages.findLast((message) => message.role === "tool")?.content,
            );
            expect(text).toContain("output truncated");
            expect(text.length).toBeLessThanOrEqual(12000);
          },
          response: { type: "text", text: "Read." },
        },
      ],
    });
    expect(exit).toBe("done");
    const output = recorded[0];
    if (!output || !("text" in output)) throw new Error("Missing native read result");
    expect(output.truncated).toBe(true);
    expect(await readFile(output.spoolPath!, "utf8")).toBe(content);
  });
});

describe("run channel conformance of the pi-native harness", () => {
  const piNative = HARNESSES["pi-native"]!;
  const guestRoot = async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-pi-native-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "workspace/bots/bot_guest"), { recursive: true });
    return root;
  };

  it("runs its own tools without a grant and reports what it added before done", async () => {
    const root = await guestRoot();
    const { exit, frames } = await driveGuest({
      harness: piNative,
      cwd: "/workspace/bots/bot_guest",
      root,
      spoolDir: path.join(root, "spool"),
      prompt: "Write a note.",
      tools: [bashTool],
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "bash-1",
            name: "bash",
            arguments: { command: "echo hi > note.md && echo ok" },
          },
        },
        { expect() {}, response: { type: "text", text: "Written." } },
      ],
    });

    expect(exit).toBe("done");
    const lifecycle = new Set(["tool", "tool.call", "tool.done", "transcript", "done"]);
    expect(frames.map((frame) => frame.type).filter((type) => lifecycle.has(type))).toEqual([
      "transcript",
      "done",
    ]);
    const transcript = frames.find((frame) => frame.type === "transcript")?.body;
    if (transcript?.type !== "transcript") throw new Error("No transcript");
    expect(transcript.systemPrompt).toContain("<addendum>\nUse the tools.\n</addendum>");
    expect(
      transcript.messages
        .filter((message) => message.role !== "system")
        .map((message) =>
          message.role === "toolResult" ? `toolResult:${message.toolName}` : message.role,
        ),
    ).toEqual(["user", "assistant", "toolResult:bash", "assistant"]);
  });

  it("reads the volume's AGENTS.md and the converged skills, never the volume's .pi/", async () => {
    const root = await guestRoot();
    const managed = path.join(root, "managed-skills/agent/interrogate");
    await mkdir(managed, { recursive: true });
    await writeFile(
      path.join(managed, "SKILL.md"),
      "---\nname: Interrogate\ndescription: Review work\n---\nRead the changes.\n",
    );
    const volume = path.join(root, "workspace/bots/bot_guest");
    const loaded = path.join(root, "extension-loaded");
    await mkdir(path.join(volume, ".pi/skills/rogue"), { recursive: true });
    await mkdir(path.join(volume, ".pi/extensions"), { recursive: true });
    await writeFile(path.join(volume, "AGENTS.md"), "Volume rule: keep notes short.\n");
    await writeFile(path.join(volume, ".pi/SYSTEM.md"), "Rogue system prompt.\n");
    await writeFile(
      path.join(volume, ".pi/skills/rogue/SKILL.md"),
      "---\nname: Rogue\ndescription: Not trusted\n---\nRun anything.\n",
    );
    await writeFile(
      path.join(volume, ".pi/extensions/rogue.ts"),
      `import { writeFileSync } from "node:fs";\nexport default () => writeFileSync(${JSON.stringify(loaded)}, "loaded");\n`,
    );

    const { exit } = await driveGuest({
      harness: piNative,
      cwd: "/workspace/bots/bot_guest",
      root,
      spoolDir: path.join(root, "spool"),
      prompt: "Reply briefly.",
      tools: [
        { name: "read", description: "Read", inputSchema: { type: "object" }, where: "guest" },
      ],
      steps: [
        {
          expect(request) {
            const prompt = String(
              request.messages.find((message) => message.role === "system")?.content,
            );
            expect(prompt).toContain("Volume rule: keep notes short.");
            expect(prompt).toContain("<name>Interrogate</name>");
            expect(prompt).not.toContain("Rogue");
          },
          response: { type: "text", text: "Done." },
        },
      ],
    });

    expect(exit).toBe("done");
    await expect(stat(loaded)).rejects.toThrow("ENOENT");
  });

  it.each([
    { error: "This run is paused until the user answers.", requests: 1, exit: "cancelled" },
    { error: "503 Service Unavailable", requests: 2, exit: "done" },
  ])(
    "retries a relay error only when it is transient: $error",
    async ({ error, requests, exit }) => {
      const root = await guestRoot();
      let relayed = 0;
      const result = await driveGuest({
        harness: piNative,
        cwd: "/workspace/bots/bot_guest",
        root,
        spoolDir: path.join(root, "spool"),
        prompt: "Reply briefly.",
        tools: [],
        steps: requests > 1 ? [{ expect() {}, response: { type: "text", text: "Done." } }] : [],
        reply: (body) =>
          body.type === "model.request" && relayed++ === 0
            ? { type: "error", message: error }
            : undefined,
      });

      expect(result.exit).toBe(exit);
      expect(result.frames.filter((frame) => frame.type === "model.request")).toHaveLength(
        requests,
      );
    },
  );
});
