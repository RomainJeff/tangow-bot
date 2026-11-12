import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Duplex } from "node:stream";
import { resolveSupervisorToken } from "@tangow/core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "");
  process.env.DATA_DIR = `${tmp}/tangow-computer-routes-${process.pid}-${Date.now()}`;
  delete process.env.HOSTNAME;
  delete process.env.SANDBOX_MAX_COMPUTERS_PER_SPACE;
  delete process.env.SANDBOX_SCREEN_NETWORK;
  delete process.env.SANDBOX_CONTROL_VIA_LOOPBACK;
  // The fake daemon is built in the file body, after the supervisor module made its client.
  return { daemon: undefined as unknown as Record<string | symbol, unknown> };
});
vi.mock("dockerode", () => ({
  default: function Docker() {
    return new Proxy({}, { get: (_target, key) => hoisted.daemon[key] });
  },
}));

import type {
  Computer,
  ComputerRuntime,
  ComputerSpec,
  ExecOptions,
  WorkerAttempt,
} from "./computer-runtime.js";
import { ComputerIdentityError, ComputerNotFoundError } from "./computer-runtime.js";
import { createSupervisor, supervisorApp } from "./index.js";

const dataDir = process.env.DATA_DIR!;
const token = resolveSupervisorToken(process.env);

interface ExecRecord {
  argv: string[];
  stdin: Buffer;
  aborted: boolean;
}

/** `hang` keeps the command running until its caller gives up on it. */
type Run = (argv: string[]) => { code: number; stdout?: string; stderr?: string } | "hang";

function frame(stream: 1 | 2, text: string) {
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(Buffer.byteLength(text), 4);
  return Buffer.concat([header, Buffer.from(text)]);
}

function notFound(id: string) {
  return Object.assign(new Error(`(HTTP code 404) no such container - ${id}`), {
    statusCode: 404,
  });
}

interface FakeContainer {
  id: string;
  image: string;
  running: boolean;
  options: {
    name?: string;
    Image: string;
    User?: string;
    Env?: string[];
    Labels?: Record<string, string>;
    HostConfig?: { NetworkMode?: string };
  };
}

/** The part of the Docker Engine the supervisor drives, kept in memory. */
function fakeDaemon() {
  const state = {
    imageId: "sha256:release-1",
    containers: new Map<string, FakeContainer>(),
    networks: new Set<string>(),
    execs: [] as ExecRecord[],
    run: (() => ({ code: 0 })) as Run,
    /** Removing a worker answers success but leaves it behind. */
    stickyWorkers: false,
  };
  const find = (id: string) => {
    const container =
      state.containers.get(id) ??
      [...state.containers.values()].find((item) => item.options.name === id);
    if (!container) throw notFound(id);
    return container;
  };
  const inspect = (container: FakeContainer) => ({
    Id: container.id,
    Name: `/${container.options.name ?? container.id}`,
    Image: container.image,
    Config: {
      Image: container.options.Image,
      User: container.options.User,
      Env: container.options.Env,
      Labels: container.options.Labels,
    },
    HostConfig: container.options.HostConfig,
    State: { Running: container.running },
    NetworkSettings: {
      Networks: { [container.options.HostConfig?.NetworkMode ?? "bridge"]: { IPAddress: "" } },
      Ports: {},
    },
    Mounts: [],
  });
  const exec = (options: { Cmd: string[]; AttachStdin?: boolean }) => {
    const record: ExecRecord = { argv: options.Cmd, stdin: Buffer.alloc(0), aborted: false };
    state.execs.push(record);
    let code = 0;
    return {
      start: async () => {
        const result = state.run(options.Cmd);
        let done = false;
        const stream = new Duplex({
          read() {},
          write(chunk: Buffer, _encoding, callback) {
            record.stdin = Buffer.concat([record.stdin, chunk]);
            callback();
          },
          destroy(error, callback) {
            if (!done) record.aborted = true;
            callback(error);
          },
        });
        if (result !== "hang") {
          setImmediate(() => {
            done = true;
            code = result.code;
            stream.push(
              Buffer.concat([frame(1, result.stdout ?? ""), frame(2, result.stderr ?? "")]),
            );
            stream.push(null);
          });
        }
        return stream;
      },
      inspect: async () => ({ Running: false, ExitCode: code }),
    };
  };
  const daemon = {
    getImage: () => ({ inspect: async () => ({ Id: state.imageId }) }),
    version: async () => ({ ApiVersion: "1.47" }),
    listContainers: async (options: { filters?: { label?: string[] } } = {}) =>
      [...state.containers.values()]
        .filter((container) =>
          (options.filters?.label ?? []).every((label) => {
            const [key, value] = label.split("=");
            return container.options.Labels?.[key!] === value;
          }),
        )
        .map((container) => ({
          Id: container.id,
          Image: container.options.Image,
          Labels: container.options.Labels,
        })),
    createContainer: async (options: FakeContainer["options"]) => {
      if (
        options.name &&
        [...state.containers.values()].some((c) => c.options.name === options.name)
      )
        throw Object.assign(new Error("Conflict"), { statusCode: 409 });
      const id = randomUUID().replaceAll("-", "");
      state.containers.set(id, { id, image: state.imageId, running: false, options });
      return daemon.getContainer(id);
    },
    getContainer: (id: string) => ({
      id,
      inspect: async () => inspect(find(id)),
      start: async () => {
        find(id).running = true;
      },
      stop: async () => {
        find(id).running = false;
      },
      remove: async () => {
        const container = find(id);
        if (state.stickyWorkers && container.options.Labels?.["tangow.worker"] === "true") return;
        state.containers.delete(container.id);
      },
      exec: async (options: { Cmd: string[] }) => {
        find(id);
        return exec(options);
      },
    }),
    createNetwork: async ({ Name }: { Name: string }) => {
      if (state.networks.has(Name)) throw new Error(`network with name ${Name} already exists`);
      state.networks.add(Name);
      return { remove: async () => state.networks.delete(Name) };
    },
    getNetwork: (name: string) => ({
      inspect: async () => {
        if (!state.networks.has(name)) throw notFound(name);
        return { Containers: {} };
      },
      remove: async () => state.networks.delete(name),
      connect: async () => undefined,
      disconnect: async () => undefined,
    }),
  };
  return { daemon, state };
}

interface Harness {
  request(pathname: string, init?: RequestInit): Promise<Response>;
  computers(): Array<{ id: string; running: boolean }>;
  workers(): string[];
  execs(): ExecRecord[];
  run(run: Run): void;
  /** The next computer image is a new release. */
  newRelease(): void;
  /** Destroying a worker leaves it running, as a lost removal would. */
  stickyWorkers(): void;
}

function dockerHarness(): Harness {
  const { daemon, state } = fakeDaemon();
  hoisted.daemon = daemon as unknown as Record<string | symbol, unknown>;
  const isWorker = (container: FakeContainer) => container.options.Labels?.["tangow.worker"];
  return {
    request: async (pathname, init) => supervisorApp.request(pathname, init),
    computers: () =>
      [...state.containers.values()]
        .filter((container) => !isWorker(container))
        .map((container) => ({ id: container.id, running: container.running })),
    workers: () => [...state.containers.values()].filter(isWorker).map((container) => container.id),
    execs: () => state.execs,
    run: (run) => {
      state.run = run;
    },
    newRelease: () => {
      state.imageId = `sha256:release-${randomUUID()}`;
    },
    stickyWorkers: () => {
      state.stickyWorkers = true;
    },
  };
}

/** The contract the routes rely on, kept in memory: what a new backend must also do. */
class FakeRuntime implements ComputerRuntime {
  releaseRef = "release-1";
  computers = new Map<
    string,
    { botId: string; spaceId: string; running: boolean; releaseRef: string }
  >();
  attempts = new Map<string, string>();
  execs: ExecRecord[] = [];
  run: Run = () => ({ code: 0 });
  sticky = false;

  async release() {
    return this.releaseRef;
  }

  private toComputer(id: string, screenPort?: string): Computer {
    const computer = this.computers.get(id)!;
    return {
      id,
      running: computer.running,
      image: "computer",
      releaseRef: computer.releaseRef,
      matchesSpec: true,
      workspace: "/home/tangow",
      ...(screenPort ? { screen: { host: "127.0.0.1", port: screenPort } } : {}),
    };
  }

  getComputer(query: {
    id: string;
    owner: { botId: string; spaceId: string };
    screenPort?: string;
  }): Promise<Computer>;
  getComputer(query: { spec: ComputerSpec }): Promise<Computer | undefined>;
  async getComputer(
    query:
      | { id: string; owner: { botId: string; spaceId: string }; screenPort?: string }
      | { spec: ComputerSpec },
  ) {
    if ("spec" in query) {
      const found = [...this.computers].find(
        ([, c]) => c.botId === query.spec.botId && c.spaceId === query.spec.spaceId,
      );
      return found && this.toComputer(found[0]);
    }
    const computer = this.computers.get(query.id);
    if (!computer) throw new ComputerNotFoundError(`no computer ${query.id}`);
    if (computer.botId !== query.owner.botId || computer.spaceId !== query.owner.spaceId)
      throw new ComputerIdentityError("computer identity mismatch");
    return this.toComputer(query.id, query.screenPort);
  }

  async ensureComputer(spec: ComputerSpec, existing?: { id: string; replace: boolean }) {
    if (existing && !existing.replace) {
      const computer = this.computers.get(existing.id)!;
      computer.running = true;
      return { id: existing.id, releaseRef: computer.releaseRef, resumed: true };
    }
    if (existing) this.computers.delete(existing.id);
    const id = `tangow-bot-${randomUUID()}`;
    this.computers.set(id, {
      botId: spec.botId,
      spaceId: spec.spaceId,
      running: true,
      releaseRef: this.releaseRef,
    });
    return { id, releaseRef: this.releaseRef, resumed: false };
  }

  async stopComputer(id: string) {
    this.computers.get(id)!.running = false;
  }

  async removeComputer(id: string) {
    this.computers.delete(id);
  }

  async exec(_id: string, argv: string[], options: ExecOptions) {
    const record: ExecRecord = { argv, stdin: options.stdin ?? Buffer.alloc(0), aborted: false };
    this.execs.push(record);
    const result = this.run(argv);
    if (result === "hang") {
      return new Promise<never>((_resolve, reject) =>
        options.signal?.addEventListener("abort", () => {
          record.aborted = true;
          reject(options.signal?.reason);
        }),
      );
    }
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code };
  }

  workers = {
    ensure: async (attempt: WorkerAttempt) => {
      const id = this.attempts.get(attempt.attemptId) ?? `tangowworker${attempt.attemptId}`;
      this.attempts.set(attempt.attemptId, id);
      return { id };
    },
    destroy: async (attemptId: string) => {
      const destroyed = this.attempts.has(attemptId);
      if (destroyed && this.sticky) throw new Error("worker still present");
      this.attempts.delete(attemptId);
      return { destroyed };
    },
    openGuest: async () => undefined,
  };
}

function fakeRuntimeHarness(): Harness {
  const runtime = new FakeRuntime();
  const { app } = createSupervisor(runtime);
  return {
    request: async (pathname, init) => app.request(pathname, init),
    computers: () =>
      [...runtime.computers].map(([id, computer]) => ({ id, running: computer.running })),
    workers: () => [...runtime.attempts.values()],
    execs: () => runtime.execs,
    run: (run) => {
      runtime.run = run;
    },
    newRelease: () => {
      runtime.releaseRef = `release-${randomUUID()}`;
    },
    stickyWorkers: () => {
      runtime.sticky = true;
    },
  };
}

const harnesses: Array<[string, () => Harness]> = [
  ["docker backend", dockerHarness],
  ["runtime contract", fakeRuntimeHarness],
];

const homePath = path.join(dataDir, "homes", "bot-1");
const volume = path.join(dataDir, "volumes", "tangow-private");

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

function headers(botId = "bot-1") {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-tangow-bot-id": botId,
    "x-tangow-space-id": "space-1",
  };
}

describe.each(harnesses)("computer routes on the %s", (_name, createHarness) => {
  let harness: Harness;

  beforeEach(() => {
    // A root test runner checks the home as the computer user, so anyone may write it.
    mkdirSync(homePath, { recursive: true });
    chmodSync(homePath, 0o777);
    mkdirSync(volume, { recursive: true });
    harness = createHarness();
  });

  async function provision() {
    const response = await harness.request("/computers", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ botId: "bot-1", spaceId: "space-1", userId: "user-1", homePath }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { id: string; releaseRef: string; resumed: boolean };
  }

  const post = (pathname: string, body: unknown, botId?: string) =>
    harness.request(pathname, {
      method: "POST",
      headers: headers(botId),
      body: JSON.stringify(body),
    });

  it("creates a computer, then resumes the same one, stopped or not", async () => {
    const created = await provision();
    expect(created).toMatchObject({ resumed: false, releaseRef: expect.any(String) });
    expect(harness.computers()).toEqual([{ id: created.id, running: true }]);

    expect(await provision()).toEqual({ ...created, resumed: true });

    expect(await (await post(`/computers/${created.id}/stop`, {})).json()).toEqual({ ok: true });
    expect(harness.computers()).toEqual([{ id: created.id, running: false }]);

    expect(await provision()).toEqual({ ...created, resumed: true });
    expect(harness.computers()).toEqual([{ id: created.id, running: true }]);
  });

  it("replaces a computer built from another release", async () => {
    const first = await provision();
    harness.newRelease();

    const second = await provision();

    expect(second.resumed).toBe(false);
    expect(second.id).not.toBe(first.id);
    expect(second.releaseRef).not.toBe(first.releaseRef);
    expect(harness.computers()).toEqual([{ id: second.id, running: true }]);
  });

  it("stops and removes only a computer that exists and belongs to the caller", async () => {
    const { id } = await provision();

    expect((await post(`/computers/${id}/stop`, {}, "bot-2")).status).toBe(403);
    expect((await post("/computers/missing/stop", {})).status).toBe(404);
    expect(harness.computers()).toEqual([{ id, running: true }]);

    const remove = () =>
      harness.request(`/computers/${id}`, { method: "DELETE", headers: headers() });
    expect(await (await remove()).json()).toEqual({ ok: true });
    expect(harness.computers()).toEqual([]);
    expect((await remove()).status).toBe(404);
  });

  it("writes a file as the command's stdin and reports a failed write", async () => {
    const { id } = await provision();
    const content = Buffer.from("hello\n");

    const written = await post(`/computers/${id}/files`, {
      path: "notes/today.txt",
      content: content.toString("base64"),
    });

    expect(await written.json()).toEqual({ ok: true });
    const write = harness.execs().at(-1)!;
    expect(write.argv).toContain("/home/tangow/notes/today.txt");
    expect(write.stdin).toEqual(content);

    harness.run(() => ({ code: 1, stderr: "disk full" }));
    const failed = await post(`/computers/${id}/files`, { path: "a.txt", content: "" });
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({ error: "disk full" });
  });

  it("abandons a command when its request is cancelled", async () => {
    const { id } = await provision();
    harness.run((argv) =>
      argv.includes("/usr/local/bin/tangow-page-browser") ? "hang" : { code: 0 },
    );
    const controller = new AbortController();

    const response = harness.request(`/computers/${id}/browser`, {
      method: "POST",
      signal: controller.signal,
      headers: headers(),
      body: JSON.stringify({ command: "act", actions: [{ kind: "click", ref: "e1" }] }),
    });
    await vi.waitFor(() =>
      expect(
        harness.execs().some((exec) => exec.argv.includes("/usr/local/bin/tangow-page-browser")),
      ).toBe(true),
    );
    controller.abort();

    expect(await (await response).json()).toMatchObject({ ok: false, uncertain: true });
    expect(harness.execs().at(-1)).toMatchObject({ aborted: true });
  });

  it("keeps one worker per attempt and confirms it is gone once destroyed", async () => {
    const ensure = () =>
      post("/workers", {
        attemptId: "attempt1",
        ttlSeconds: 60,
        mounts: [{ volume: "tangow-private", path: "/workspace/bot", readOnly: false }],
      });
    const destroy = () =>
      harness.request("/workers?attempt=attempt1", { method: "DELETE", headers: headers() });

    const { id } = (await (await ensure()).json()) as { id: string };
    expect(await (await ensure()).json()).toEqual({ id });
    expect(harness.workers()).toEqual([id]);

    expect(await (await destroy()).json()).toEqual({ destroyed: true });
    expect(harness.workers()).toEqual([]);
    expect(await (await destroy()).json()).toEqual({ destroyed: false });
  });

  it("refuses to confirm a destroy that left the worker behind", async () => {
    harness.stickyWorkers();
    await post("/workers", { attemptId: "attempt2", ttlSeconds: 60, mounts: [] });

    const response = await harness.request("/workers?attempt=attempt2", {
      method: "DELETE",
      headers: headers(),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "worker still present" });
  });
});
