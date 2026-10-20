import type { WorkerSpec } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { E2BWorkerSandbox, E2BWorkerSdk } from "./e2b-worker.js";
import { E2B_CREATE_MARGIN_MS, E2BWorkerProvider } from "./e2b-worker.js";
import { encodeFrameLine } from "./runtime-worker/framing.js";

type Guest = {
  sandboxId: string;
  command: string;
  envs: Record<string, string>;
  stdin: string[];
  print(data: string): Promise<void>;
  printError(data: string): void;
  exit(code?: number): void;
  breakStream(): void;
  failStdinAt(index: number): void;
};

/** E2B as the worker sees it: sandboxes found by metadata, mounts that name an existing volume. */
function fakeE2B() {
  const sandboxes = new Map<string, E2BWorkerSandbox>();
  const volumes = new Set<string>();
  const guests: Guest[] = [];
  let created = 0;
  const sdk: E2BWorkerSdk = {
    async listSandboxes(metadata) {
      return [...sandboxes]
        .filter(([, sandbox]) =>
          Object.entries(metadata).every(([key, value]) => sandbox.metadata?.[key] === value),
        )
        .map(([id]) => id);
    },
    async createSandbox(options) {
      for (const name of Object.values(options.volumeMounts)) {
        if (!volumes.has(name)) throw new Error(`No volume named ${name}`);
      }
      const id = `sbx_${++created}`;
      sandboxes.set(id, options);
      return id;
    },
    async killSandbox(id) {
      return sandboxes.delete(id);
    },
    async startGuest(sandboxId, command, { envs, onStdout, onStderr }) {
      let exit = (_code: number) => {};
      let breakStream = () => {};
      const ended = new Promise<number>((resolve, reject) => {
        exit = resolve;
        breakStream = () => reject(new Error("stream reset"));
      });
      const stdin: string[] = [];
      let failAt = -1;
      let sends = 0;
      guests.push({
        sandboxId,
        command,
        envs,
        stdin,
        print: onStdout,
        printError: onStderr,
        exit: (code = 0) => exit(code),
        breakStream: () => breakStream(),
        failStdinAt: (index) => (failAt = index),
      });
      return {
        sendStdin: async (data) => {
          if (sends++ === failAt) throw new Error("stdin request failed");
          stdin.push(data);
        },
        closeStdin: async () => undefined,
        wait: () => ended,
      };
    },
    async listVolumes() {
      return [...volumes];
    },
    async createVolume(name) {
      volumes.add(name);
      return name;
    },
    async destroyVolume(name) {
      return volumes.delete(name);
    },
  };
  return { sdk, sandboxes, volumes, guests };
}

const config = { apiKey: "e2b-test-key", template: "rakazo-worker-pi" };

function spec(mounts: WorkerSpec["mounts"], overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  return {
    attemptId: "attempt_1",
    runId: "run_1",
    botId: "bot_1",
    mounts,
    ttlSeconds: 14_400,
    ensureDeadline: new Date(Date.now() + 900_000),
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A deadline that leaves `ms` of creating time once the provider's margin is taken. */
const creatingFor = (ms: number) => ({
  ensureDeadline: new Date(Date.now() + E2B_CREATE_MARGIN_MS + ms),
});
const settled = (promise: Promise<void>) =>
  Promise.race([promise.then(() => "settled"), sleep(10).then(() => "pending")]);

async function connected(e2b: ReturnType<typeof fakeE2B>, worker: E2BWorkerProvider) {
  const guest = worker.connect({ attemptId: "attempt_1", providerRef: "sbx_1" }, "rkw1.claims.mac");
  const channels = guest.connections[Symbol.asyncIterator]();
  const channel = (await channels.next()).value!;
  return { ...guest, channels, channel, fake: e2b.guests.at(-1)! };
}

const previousLogger = getLogger();
afterEach(() => installLogger(previousLogger));

describe("E2BWorkerProvider", () => {
  it("creates one secure sandbox per attempt with its volumes mounted by name", async () => {
    const e2b = fakeE2B();
    const worker = new E2BWorkerProvider(config, e2b.sdk);
    const bot = await worker.ensureVolume({
      name: "rakazo-vol_bot",
      ensureDeadline: spec([]).ensureDeadline,
    });
    const shared = await worker.ensureVolume({
      name: "rakazo-vol_shared",
      ensureDeadline: spec([]).ensureDeadline,
    });
    const attempt = spec([
      { volumeRef: bot.providerRef, path: "/workspace/bots/bot_1", access: "rw" },
      { volumeRef: shared.providerRef, path: "/workspace/shared", access: "rw" },
    ]);

    const first = await worker.ensure(attempt);
    const again = await worker.ensure(attempt);

    expect([first, again]).toEqual([{ providerRef: "sbx_1" }, { providerRef: "sbx_1" }]);
    const { requestTimeoutMs, signal, ...created } = e2b.sandboxes.get("sbx_1")!;
    expect(created).toEqual({
      template: "rakazo-worker-pi",
      secure: true,
      metadata: { rakazo: "worker", attemptId: "attempt_1" },
      envs: {
        RAKAZO_WORKER_HARNESS: "pi",
        RAKAZO_WORKER_SPOOL_DIR: "/workspace/bots/bot_1/.rakazo/tool-output",
      },
      volumeMounts: {
        "/workspace/bots/bot_1": "rakazo-vol_bot",
        "/workspace/shared": "rakazo-vol_shared",
      },
      timeoutMs: 14_400_000,
      lifecycle: { onTimeout: "kill" },
    });
  });

  it("leaves tool output to the guest's temporary directory without a private volume", async () => {
    const e2b = fakeE2B();
    const worker = new E2BWorkerProvider({ ...config, harness: "other" }, e2b.sdk);

    await worker.ensure(spec([]));

    const { envs, volumeMounts } = e2b.sandboxes.get("sbx_1")!;
    expect({ envs, volumeMounts }).toEqual({
      envs: { RAKAZO_WORKER_HARNESS: "other" },
      volumeMounts: {},
    });
  });

  it("creates nothing once the deadline passed while it looked for the attempt's sandbox", async () => {
    const e2b = fakeE2B();
    const worker = new E2BWorkerProvider(config, {
      ...e2b.sdk,
      listSandboxes: async (metadata) => {
        await sleep(60);
        return e2b.sdk.listSandboxes(metadata);
      },
    });

    await expect(worker.ensure(spec([], creatingFor(50)))).rejects.toThrow(
      "The worker of attempt_1 missed its deadline",
    );
    expect(e2b.sandboxes.size).toBe(0);
  });

  it("aborts a create still pending at the deadline", async () => {
    const e2b = fakeE2B();
    const worker = new E2BWorkerProvider(config, {
      ...e2b.sdk,
      createSandbox: ({ signal }) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("create aborted"))),
        ),
    });

    await expect(worker.ensure(spec([], creatingFor(50)))).rejects.toThrow("create aborted");
  });

  it("destroys every sandbox of the attempt, tagged or referenced, then reports none left", async () => {
    const e2b = fakeE2B();
    const worker = new E2BWorkerProvider(config, e2b.sdk);
    await worker.ensure(spec([]));
    await e2b.sdk.createSandbox({
      ...e2b.sandboxes.get("sbx_1")!,
      metadata: { rakazo: "worker", attemptId: "attempt_1" },
    });
    await worker.ensure(spec([], { attemptId: "attempt_2" }));

    const destroyed = await worker.destroy({ attemptId: "attempt_1", providerRef: "sbx_1" });
    const again = await worker.destroy({ attemptId: "attempt_1", providerRef: "sbx_1" });

    expect([destroyed, again]).toEqual(["destroyed", "absent"]);
    expect([...e2b.sandboxes.keys()]).toEqual(["sbx_3"]);
  });

  it("returns a volume's name and creates it once", async () => {
    const e2b = fakeE2B();
    const worker = new E2BWorkerProvider(config, e2b.sdk);

    const refs = [
      await worker.ensureVolume({ name: "rakazo-vol_1", ensureDeadline: spec([]).ensureDeadline }),
      await worker.ensureVolume({ name: "rakazo-vol_1", ensureDeadline: spec([]).ensureDeadline }),
    ];

    expect(refs).toEqual([{ providerRef: "rakazo-vol_1" }, { providerRef: "rakazo-vol_1" }]);
    expect([...e2b.volumes]).toEqual(["rakazo-vol_1"]);
  });

  it("does not create a volume after a slow lookup exhausts its create deadline", async () => {
    const e2b = fakeE2B();
    const input = { name: "rakazo-delayed", ...creatingFor(1_000) };
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const worker = new E2BWorkerProvider(config, {
      ...e2b.sdk,
      async listVolumes() {
        clock.mockReturnValue(now + 1_001);
        return [];
      },
    });
    try {
      await expect(worker.ensureVolume(input)).rejects.toThrow(
        "Volume creation missed its deadline",
      );
      expect([...e2b.volumes]).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  it("carries frames both ways over the guest's stdio and ends when the command does", async () => {
    const e2b = fakeE2B();
    const worker = new E2BWorkerProvider(config, e2b.sdk);
    const { connections, exited } = worker.connect(
      { attemptId: "attempt_1", providerRef: "sbx_1" },
      "rkw1.claims.mac",
    );
    const channels = connections[Symbol.asyncIterator]();
    const channel = (await channels.next()).value!;
    const [guest] = e2b.guests;
    const frames = channel.frames[Symbol.asyncIterator]();

    const line = encodeFrameLine(Buffer.from('{"kind":"worker.hello"}'));
    void guest!.print(line.slice(0, 5));
    void guest!.print(line.slice(5));
    const hello = await frames.next();
    await channel.send(Buffer.from('{"kind":"worker.start"}'));
    guest!.exit();
    await exited;

    expect(guest).toMatchObject({
      sandboxId: "sbx_1",
      command: "node /opt/rakazo/agent-run-worker.mjs",
      envs: { RAKAZO_WORKER_CAPABILITY: "rkw1.claims.mac" },
    });
    expect(Buffer.from(hello.value!).toString()).toBe('{"kind":"worker.hello"}');
    expect(guest!.stdin.map((sent) => Buffer.from(sent, "base64").toString())).toEqual([
      '{"kind":"worker.start"}',
    ]);
    expect(await frames.next()).toEqual({ done: true, value: undefined });
    expect(await channels.next()).toEqual({ done: true, value: undefined });
  });

  it.each([
    ["its stream breaks", (guest: Guest) => guest.breakStream()],
    ["a send to it fails", (guest: Guest) => guest.failStdinAt(0)],
  ])(
    "ends the connection when %s, and settles exited only once destroyed",
    async (_name, fault) => {
      const e2b = fakeE2B();
      const worker = new E2BWorkerProvider(config, e2b.sdk);
      await worker.ensure(spec([]));
      const { channel, channels, exited, fake } = await connected(e2b, worker);

      fault(fake);
      await channel.send(Buffer.from("{}"));

      expect(await channel.frames[Symbol.asyncIterator]().next()).toEqual({
        done: true,
        value: undefined,
      });
      expect(await channels.next()).toEqual({ done: true, value: undefined });
      expect(await settled(exited)).toBe("pending");
      await worker.destroy({ attemptId: "attempt_1", providerRef: "sbx_1" });
      expect(await settled(exited)).toBe("settled");
    },
  );

  it("opens no connection to a guest that cannot start, and settles exited once destroyed", async () => {
    const e2b = fakeE2B();
    const worker = new E2BWorkerProvider(config, {
      ...e2b.sdk,
      startGuest: async () => {
        throw new Error("sandbox not found");
      },
    });

    const { connections, exited } = worker.connect(
      { attemptId: "attempt_1", providerRef: "sbx_gone" },
      "rkw1.claims.mac",
    );

    expect(await connections[Symbol.asyncIterator]().next()).toEqual({
      done: true,
      value: undefined,
    });
    expect(await settled(exited)).toBe("pending");
    await expect(worker.destroy({ attemptId: "attempt_1", providerRef: "sbx_gone" })).resolves.toBe(
      "absent",
    );
    expect(await settled(exited)).toBe("settled");
  });

  it("sends nothing after a failed send, so the guest never reads past a gap", async () => {
    const e2b = fakeE2B();
    const worker = new E2BWorkerProvider(config, e2b.sdk);
    const { channel, fake } = await connected(e2b, worker);
    fake.failStdinAt(1);

    await Promise.all(["one", "two", "three"].map((text) => channel.send(Buffer.from(text))));

    expect(fake.stdin.map((sent) => Buffer.from(sent, "base64").toString())).toEqual(["one"]);
  });

  it("logs a failing guest's stderr tail as an inert field", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const e2b = fakeE2B();
    const worker = new E2BWorkerProvider(config, e2b.sdk);
    const { exited, fake } = await connected(e2b, worker);

    fake.printError(`${"x".repeat(3000)}\nboom\u001b[2K\u202e`);
    fake.exit(3);
    await exited;

    expect(sink.events).toMatchObject([
      {
        level: "info",
        message: "e2b worker guest exited with an error",
        attemptId: "attempt_1",
        exitCode: 3,
        stderrTail: `${"x".repeat(2038)}\\u000aboom\\u001b[2K\\u202e`,
      },
    ]);
  });
});
