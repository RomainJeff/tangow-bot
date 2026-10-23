import { createHash } from "node:crypto";
import path from "node:path";
import type { CommandHandle, CommandResult } from "@e2b/desktop";
import { CommandExitError, Sandbox, TimeoutError } from "@e2b/desktop";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PageBrowserCommand,
  PageBrowserResult,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
} from "@rakazo/adapter-kit";
import {
  boundedSandboxCommandTimeoutMs,
  underVolumeMounts,
  type VolumeHome,
  volumeMountPath,
  WORKSPACE_ROOT,
} from "@rakazo/core";
import { stopAllDesktopBrowsersCommand } from "@rakazo/core/node/desktop-runtime";
import { sandboxIdleMs } from "./computer-idle.js";
import { ComputerScreenUnavailableError } from "./computer-screens.js";
import { normalizeWorkspacePath, shellQuote, workspacePath } from "./computer-support.js";
import {
  PORTABLE_TRANSFER_BATCH_BYTES,
  shouldSkipPortableWorkspaceFile,
} from "./computer-workspace.js";
import { e2bBrowserMetricsCommands } from "./e2b-browser-metrics.js";
import type { DesktopExecutionOptions } from "./linux-desktop.js";
import { LinuxDesktop, PREPARE_LINUX_DESKTOP } from "./linux-desktop.js";

const E2B_WORKSPACE = "/home/user/rakazo-home";
const E2B_DESKTOP_ENV = {
  homeDir: "/home/user",
  workspaceDir: E2B_WORKSPACE,
  browserProfilesDir: `${E2B_WORKSPACE}/.browser-profiles`,
  displayStart: 20,
  portStart: 6100,
};

export interface E2BSandboxSdk {
  create(options: ReturnType<typeof e2bCreateOptions>): Promise<Sandbox>;
  connect(id: string, options: { apiKey: string; timeoutMs: number }): Promise<Sandbox>;
  pause(id: string, options: { apiKey: string }): Promise<void>;
}

/**
 * The set of volumes a computer mounts, as recorded in its metadata: part of its identity, since a
 * running machine cannot mount another volume. A machine created before its home moved has none.
 */
function mountSet(volumeHome: VolumeHome): string {
  const mounts = volumeHome.mounts.map((mount) => [mount.path, mount.volumeRef]).sort();
  return createHash("sha256")
    .update(JSON.stringify({ root: volumeHome.root, mounts }))
    .digest("hex");
}

/** The workspace directories on a volume, relative to the workspace ("" for all of it). */
function writableRoots(volumeHome: VolumeHome): string[] {
  return volumeHome.mounts.flatMap((mount) => {
    if (volumeHome.root === mount.path || volumeHome.root.startsWith(`${mount.path}/`)) return [""];
    return mount.path.startsWith(`${volumeHome.root}/`)
      ? [mount.path.slice(volumeHome.root.length + 1)]
      : [];
  });
}

export function e2bCreateOptions(botId: string, apiKey: string, volumeHome?: VolumeHome) {
  return {
    apiKey,
    timeoutMs: sandboxIdleMs(),
    metadata: {
      botId,
      rakazo: "computer",
      ...(volumeHome ? { home: "volumes", mounts: mountSet(volumeHome) } : {}),
    },
    resolution: [1280, 800] as [number, number],
    lifecycle: { onTimeout: "pause" as const, autoResume: false },
    ...(volumeHome && {
      volumeMounts: Object.fromEntries(
        volumeHome.mounts.map((mount) => [mount.path, mount.volumeRef]),
      ),
    }),
  };
}

/**
 * Points `link` at `target`. `ln -sfn` would nest the link inside a real directory and succeed, so
 * an empty directory is removed first, a directory with files in it fails, and the result is read
 * back.
 */
export function linkWorkspaceCommand(target: string, link: string): string {
  const [to, at] = [shellQuote(target), shellQuote(link)];
  return [
    `if [ -L ${at} ]; then rm -f ${at}`,
    `elif [ -d ${at} ]; then rmdir ${at} 2>/dev/null || { echo ${shellQuote(`${link} has files in it, so it cannot link to ${target}`)} >&2; exit 1; }`,
    `elif [ -e ${at} ]; then echo ${shellQuote(`${link} is a file, so it cannot link to ${target}`)} >&2; exit 1; fi`,
    `ln -s ${to} ${at}`,
    `[ "$(readlink ${at})" = ${to} ] || { echo ${shellQuote(`${link} does not link to ${target}`)} >&2; exit 1; }`,
  ].join("\n");
}

// How the E2B SDK words a sandbox that no longer exists. It does not always say "not found":
// an expired sandbox surfaces as a TimeoutError about the *sandbox* timeout (502 / Unavailable
// from envd), which used to read as a live sandbox and left every later call throwing forever.
const SANDBOX_GONE_MESSAGE =
  /probably not running anymore|likely due to sandbox timeout|killed or reached its end of life|sandbox [^:]{0,60}not found|sandbox [^:]{0,60}does not exist/i;
// The same words from a live sandbox: a missing binary or a missing file inside it.
const SHELL_MISSING_TARGET = /command not found|no such file|^path .* not found/i;
/** Only provider-specific evidence of sandbox loss permits automatic replacement. */
export function isSandboxGoneError(error: unknown): boolean {
  const message = errorMessage(error);
  if (SHELL_MISSING_TARGET.test(message)) return false;
  if (SANDBOX_GONE_MESSAGE.test(message)) return true;
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current.name === "SandboxNotFoundError") return true;
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A self-hosted proxy reached on a local `*.localhost` domain serves plain HTTP. */
export function e2bScreenUrl(host: string): string {
  const scheme = /^([^.:]+\.)*localhost(:\d+)?$/.test(host) ? "http" : "https";
  return `${scheme}://${host}/vnc.html`;
}

export class E2BSandboxProvider implements SandboxProvider {
  private readonly desktops = new LinuxDesktop({
    profileCommands: e2bBrowserMetricsCommands,
    environment: async (computer, context) => {
      const onVolumes =
        computer.writableRoots !== undefined ||
        (await (await this.box(computer)).getInfo()).metadata.home === "volumes";
      if (!onVolumes) return E2B_DESKTOP_ENV;
      if (!context.botId) throw new ComputerScreenUnavailableError();
      return {
        ...E2B_DESKTOP_ENV,
        browserProfilesDir: `${volumeMountPath({ kind: "bot_private", botId: context.botId })}/.browser-profiles`,
      };
    },
    run: async (computer, command, context, options) => {
      const desktop = await this.box(computer);
      if (options) return this.runDesktopOperation(desktop, command, context.signal, options);
      const result = await this.runSetupCommand(desktop, command, context.signal);
      return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    screenUrl: async (computer, port) => e2bScreenUrl((await this.box(computer)).getHost(port)),
  });
  private readonly boxes = new Map<string, Sandbox>();
  private readonly connections = new Map<string, Promise<Sandbox>>();
  private readonly lastTouchedAt = new Map<string, number>();

  constructor(
    private readonly apiKey: string,
    private readonly sdk: E2BSandboxSdk = Sandbox as unknown as E2BSandboxSdk,
  ) {}

  describe() {
    return {
      id: "e2b",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: true,
        multiScreen: true,
      },
    };
  }

  private async box(computer: ComputerRef): Promise<Sandbox> {
    const id = computer.providerRef || computer.id;
    const existing = this.boxes.get(id);
    if (existing) {
      const lastTouched = this.lastTouchedAt.get(id) ?? 0;
      if (Date.now() - lastTouched < 60_000) return existing;
      // A cached handle to a sandbox E2B already killed keeps throwing on every call, and the
      // process never reconnects. The keepalive is the cheapest place to notice and drop it.
      const gone = await existing.setTimeout(sandboxIdleMs()).then(
        () => false,
        (error: unknown) => isSandboxGoneError(error),
      );
      if (!gone) {
        this.lastTouchedAt.set(id, Date.now());
        return existing;
      }
      if (this.boxes.get(id) === existing) this.forget(id);
    }
    const pending = this.connections.get(id);
    if (pending) return pending;
    let connection!: Promise<Sandbox>;
    connection = this.sdk
      .connect(id, { apiKey: this.apiKey, timeoutMs: sandboxIdleMs() })
      .then((connected) => {
        if (this.connections.get(id) !== connection) {
          throw new Error("computer connection stopped during teardown");
        }
        this.boxes.set(connected.sandboxId, connected);
        this.lastTouchedAt.set(connected.sandboxId, Date.now());
        return connected;
      })
      .finally(() => {
        if (this.connections.get(id) === connection) this.connections.delete(id);
      });
    this.connections.set(id, connection);
    return connection;
  }

  async provision(
    request: Parameters<SandboxProvider["provision"]>[0],
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const volumeHome = request.volumeHome;
    const onVolumes = volumeHome ? { writableRoots: writableRoots(volumeHome) } : {};
    if (request.providerRef && request.providerKind === "e2b") {
      try {
        const machine: ComputerRef = {
          id: request.providerRef,
          providerRef: request.providerRef,
          kind: "e2b",
          botId: request.botId,
        };
        const desktop = await this.box(machine);
        const metadata = volumeHome ? (await desktop.getInfo()).metadata : {};
        if (!volumeHome || metadata.mounts === mountSet(volumeHome)) {
          return {
            id: desktop.sandboxId,
            botId: request.botId,
            kind: "e2b",
            providerRef: desktop.sandboxId,
            fresh: false,
            ...onVolumes,
          };
        }
        // Created before its home moved, or with another set of volumes: what it holds off the
        // volumes may be newer than any copy, so it is archived before the machine goes.
        await volumeHome.archive(
          this.filesOffVolumes(
            machine,
            desktop,
            metadata.home === "volumes" ? volumeHome.root : null,
            context,
          ),
        );
        this.forget(desktop.sandboxId);
        await desktop.kill();
      } catch (error) {
        this.boxes.delete(request.providerRef);
        // A transport failure says nothing about the workspace still on the server.
        if (!isSandboxGoneError(error)) throw error;
      }
    }
    const desktop = await this.sdk.create(e2bCreateOptions(request.botId, this.apiKey, volumeHome));
    if (volumeHome) {
      // The workspace is the volumes' own root, so a file has the same path here as in a worker.
      const linked = await this.runSetupCommand(
        desktop,
        linkWorkspaceCommand(volumeHome.root, E2B_WORKSPACE),
      );
      if (linked.exitCode !== 0) {
        await desktop.kill().catch(() => undefined);
        throw new Error(linked.stderr || "could not link the computer workspace to its volumes");
      }
    }
    this.boxes.set(desktop.sandboxId, desktop);
    this.lastTouchedAt.set(desktop.sandboxId, Date.now());
    return {
      id: desktop.sandboxId,
      botId: request.botId,
      kind: "e2b",
      providerRef: desktop.sandboxId,
      fresh: true,
      ...onVolumes,
    };
  }

  private async stopBrowsers(computer: ComputerRef, context: AdapterContext) {
    const profiles = "RAKAZO_INTERNAL_PROFILES";
    const stop = stopAllDesktopBrowsersCommand(
      {
        ...E2B_DESKTOP_ENV,
        browserProfilesDir: profiles,
      },
      e2bBrowserMetricsCommands,
    ).replaceAll(shellQuote(profiles), '"$1"');
    const result = await this.runSetupCommand(
      await this.box(computer),
      [
        "set -eu",
        `for profiles in ${shellQuote(E2B_DESKTOP_ENV.browserProfilesDir)} ${shellQuote(WORKSPACE_ROOT)}/bots/*/.browser-profiles; do`,
        '  [ -d "$profiles" ] || continue',
        `  bash -eu -c ${shellQuote(stop)} desktop "$profiles"`,
        "done",
      ].join("\n"),
      context.signal,
    );
    if (result.exitCode !== 0) throw new Error(result.stderr || "computer browsers failed to stop");
  }

  /**
   * A discarded machine's workspace files on no volume: all of them on a machine created before
   * its home moved (`root` null), else those outside the mount points under the volumes' root.
   */
  private async *filesOffVolumes(
    machine: ComputerRef,
    desktop: Sandbox,
    root: string | null,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    await this.stopBrowsers(machine, context);
    yield* walkE2BWorkspace(desktop, "", context, (relative) =>
      root === null ? true : !underVolumeMounts(path.posix.join(root, relative)),
    );
  }

  async prepare(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const desktop = await this.box(computer);
    // On volumes the workspace is a link provision made: a directory there would break it.
    if (computer.fresh && !computer.writableRoots) await desktop.files.makeDir(E2B_WORKSPACE);
    const result = await this.runSetupCommand(desktop, PREPARE_LINUX_DESKTOP, _context.signal);
    if (result.exitCode !== 0)
      throw new Error(result.stderr || "could not prepare computer desktop tools");
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const desktop = await this.box(computer);
    const cmd = request.argv.map(shellQuote).join(" ");
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    try {
      const result = await desktop.commands.run(cmd, {
        cwd: e2bCwd(computer, request.cwd),
        envs: request.env,
        signal: context.signal,
        timeoutMs,
      });
      if (result.stdout) yield { type: "stdout", data: result.stdout };
      if (result.stderr) yield { type: "stderr", data: result.stderr };
      yield { type: "exit", code: result.exitCode ?? 0 };
    } catch (error) {
      if (error instanceof TimeoutError) {
        yield {
          type: "stderr",
          data: `command timed out after ${timeoutMs} ms\n`,
        };
        yield { type: "exit", code: 124 };
        return;
      }
      throw error;
    }
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    return this.desktops.connectScreen(computer, request, context);
  }
  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ): Promise<void> {
    return this.desktops.setScreenControl(computer, interactive, context, controlToken);
  }
  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    return this.desktops.sendInput(computer, input, context);
  }
  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    return this.desktops.observe(computer, context);
  }
  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return this.desktops.act(computer, request, context);
  }

  async pageBrowser(
    computer: ComputerRef,
    request: PageBrowserCommand,
    context: AdapterContext,
  ): Promise<PageBrowserResult> {
    return this.desktops.pageBrowser(computer, request, context);
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const desktop = await this.box(computer);
    const relative = normalizeWorkspacePath(directory);
    const entries = await desktop.files.list(workspacePath(E2B_WORKSPACE, relative), {
      signal: context.signal,
    });
    return entries.flatMap((entry) => {
      if (entry.type !== "file" && entry.type !== "dir") return [];
      return [
        {
          path: normalizeWorkspacePath(relative ? `${relative}/${entry.name}` : entry.name),
          kind: entry.type,
          size: entry.size,
          ...(entry.type === "file" && entry.mode & 0o100 ? { executable: true } : {}),
        },
      ];
    });
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const desktop = await this.box(computer);
    const target = workspacePath(E2B_WORKSPACE, filePath);
    if (options?.maxBytes !== undefined) {
      const info = await desktop.files.getInfo(target, {
        signal: context.signal,
      });
      if (info.size > options.maxBytes) {
        throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
      }
    }
    return desktop.files.read(target, {
      format: "bytes",
      signal: context.signal,
    });
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const roots = computer.writableRoots;
    const relative = normalizeWorkspacePath(file.path);
    if (
      roots &&
      !roots.some((root) => !root || relative === root || relative.startsWith(`${root}/`))
    ) {
      throw new Error(
        `${file.path} is on no mounted volume, so it would be lost when this computer is replaced; write under ${roots.join(", ") || "a mounted volume"}`,
      );
    }
    const desktop = await this.box(computer);
    await writeE2BFiles(desktop, [file], context);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const desktop = await this.box(computer);
    await this.stopBrowsers(computer, context);
    yield* walkE2BWorkspace(desktop, "", context);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    const desktop = await this.box(computer);
    await this.stopBrowsers(computer, context);
    let batch: PortableFile[] = [];
    let batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      await writeE2BFiles(desktop, batch, context);
      batch = [];
      batchBytes = 0;
    };
    for await (const file of files) {
      if (
        batch.length >= 32 ||
        batchBytes + file.content.byteLength > PORTABLE_TRANSFER_BATCH_BYTES
      ) {
        await flush();
      }
      batch.push(file);
      batchBytes += file.content.byteLength;
    }
    await flush();
    // Imported browser profiles remain dormant until their owning bot needs a desktop.
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    const observation = await this.observe(computer, _context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    const desktop = await this.box(computer);
    try {
      await desktop.setTimeout(sandboxIdleMs());
    } catch (error) {
      // Heartbeats refresh lastTouchedAt; if we swallow a gone error here, box() never
      // reaches its 60s probe and keeps handing back the dead cached handle.
      if (isSandboxGoneError(error)) {
        this.forget(desktop.sandboxId);
        return;
      }
    }
    this.lastTouchedAt.set(desktop.sandboxId, Date.now());
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    return this.desktops.releaseScreen(computer, context);
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const desktop = this.boxes.get(id);
    this.forget(id);
    if (desktop) {
      await desktop.pause().catch(() => undefined);
      return;
    }
    await this.sdk.pause(id, { apiKey: this.apiKey }).catch(() => undefined);
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const desktop = this.boxes.get(id) ?? (await this.box(computer).catch(() => undefined));
    this.forget(id);
    // The SDK returns false when the sandbox is already gone; teardown is complete.
    await desktop?.kill();
  }

  private forget(id: string): void {
    this.boxes.delete(id);
    this.connections.delete(id);
    this.lastTouchedAt.delete(id);
  }

  private async runDesktopOperation(
    desktop: Sandbox,
    command: string,
    signal: AbortSignal,
    options: DesktopExecutionOptions,
  ) {
    let handle: CommandHandle | undefined;
    let inputDispatched = false;
    let bytes = 0;
    let stdout = "";
    let stderr = "";
    let finished = false;
    const bounded = new AbortController();
    const operationSignal = AbortSignal.any([signal, bounded.signal]);
    const collect = (chunk: string, output: "stdout" | "stderr") => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > options.maxOutputBytes) {
        const error = new Error("page browser output exceeds limit");
        bounded.abort(error);
        throw error;
      }
      if (output === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    try {
      operationSignal.throwIfAborted();
      const timeoutMs = Math.max(1, options.deadline - Date.now());
      handle = await desktop.commands.run(command, {
        background: true,
        stdin: true,
        signal: operationSignal,
        timeoutMs,
        requestTimeoutMs: timeoutMs,
        onStdout: (chunk) => collect(chunk, "stdout"),
        onStderr: (chunk) => collect(chunk, "stderr"),
      });
      operationSignal.throwIfAborted();
      if (Date.now() >= options.deadline) throw new Error("page browser operation timed out");
      // A failed send may still have delivered the permit. Never send it twice.
      inputDispatched = true;
      await handle.sendStdin(options.input, {
        signal: operationSignal,
        requestTimeoutMs: Math.max(1, options.deadline - Date.now()),
      });
      const result = await handle.wait();
      operationSignal.throwIfAborted();
      finished = true;
      return { code: result.exitCode, stdout, stderr, inputDispatched };
    } catch (error) {
      return {
        code: error instanceof CommandExitError ? error.exitCode : 1,
        stdout,
        stderr: stderr || errorMessage(error),
        inputDispatched,
      };
    } finally {
      if (handle) {
        // EOF stops the helper; a fresh group signal also covers a shell waiting for a lock.
        // SDK kill is PID-only, so it must never be the first way we stop timeout.
        const cleanupSignal = AbortSignal.timeout(3000);
        await Promise.allSettled([
          handle.closeStdin({ signal: cleanupSignal, requestTimeoutMs: 1000 }),
          ...(!finished
            ? [
                desktop.commands.run(`kill -KILL -- -${handle.pid}`, {
                  signal: cleanupSignal,
                  requestTimeoutMs: 2000,
                  timeoutMs: 2000,
                }),
              ]
            : []),
        ]);
        // If group cleanup cannot reach an armed operation, retain its remote watchdog.
        if (!inputDispatched)
          await desktop.commands
            .kill(handle.pid, { signal: cleanupSignal, requestTimeoutMs: 1000 })
            .catch(() => undefined);
        await handle.disconnect().catch(() => undefined);
      }
    }
  }

  /** Apply the deployment timeout (SDK default is 60s) and return failed results instead of throwing. */
  private async runSetupCommand(
    desktop: Sandbox,
    command: string,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    try {
      // E2B's outer login shell can fail its logout hook under `set -e`, even after `exit 0`.
      return await desktop.commands.run(`bash -c ${shellQuote(command)}`, {
        ...(signal ? { signal } : {}),
        timeoutMs: boundedSandboxCommandTimeoutMs(undefined),
      });
    } catch (error) {
      if (error instanceof TimeoutError) {
        return {
          exitCode: 124,
          stdout: "",
          stderr: error.message,
          error: error.message,
        };
      }
      const result = (error as { result?: CommandResult }).result;
      if (result) return result;
      throw error;
    }
  }
}

async function writeE2BFiles(
  desktop: Sandbox,
  files: readonly PortableFile[],
  context: AdapterContext,
) {
  if (!files.length) return;
  await desktop.files.write(
    files.map((file) => ({
      path: workspacePath(E2B_WORKSPACE, file.path),
      data: toArrayBuffer(file.content),
    })),
    { signal: context.signal },
  );
  const executable = files
    .filter((file) => file.executable)
    .map((file) => shellQuote(workspacePath(E2B_WORKSPACE, file.path)));
  if (executable.length) {
    await desktop.commands.run(`chmod 700 -- ${executable.join(" ")}`, {
      signal: context.signal,
    });
  }
}

async function* walkE2BWorkspace(
  desktop: Sandbox,
  directory: string,
  context: AdapterContext,
  keep: (relative: string) => boolean = () => true,
): AsyncIterable<PortableFile> {
  const entries = await desktop.files.list(workspacePath(E2B_WORKSPACE, directory), {
    signal: context.signal,
  });
  const files: Array<{ relative: string; mode: number }> = [];
  const directories: string[] = [];
  for (const entry of entries) {
    const relative = normalizeWorkspacePath(directory ? `${directory}/${entry.name}` : entry.name);
    if (shouldSkipPortableWorkspaceFile(relative) || !keep(relative)) continue;
    if (entry.type === "dir") directories.push(relative);
    else if (entry.type === "file") files.push({ relative, mode: entry.mode });
  }
  for (let index = 0; index < files.length; index += 8) {
    const batch = await Promise.all(
      files.slice(index, index + 8).map(async ({ relative, mode }) => {
        const content = await desktop.files
          .read(workspacePath(E2B_WORKSPACE, relative), {
            format: "bytes",
            signal: context.signal,
          })
          .catch((error) => {
            if (relative.startsWith(".browser-profiles/")) return undefined;
            throw error;
          });
        if (!content) return undefined;
        return { path: relative, content, executable: Boolean(mode & 0o100) };
      }),
    );
    for (const file of batch) {
      if (file) yield file;
    }
  }
  for (const relative of directories) yield* walkE2BWorkspace(desktop, relative, context, keep);
}

/** A worker's path is a real one on a computer that mounts its volumes. */
function e2bCwd(computer: ComputerRef, cwd: string | undefined): string {
  if (computer.writableRoots && cwd?.startsWith("/")) {
    const absolute = `/${normalizeWorkspacePath(cwd)}`;
    if (underVolumeMounts(absolute)) return absolute;
  }
  if (
    !cwd ||
    cwd === "." ||
    cwd === "/" ||
    cwd === "/home/rakazo" ||
    cwd === "/home/user" ||
    cwd === E2B_WORKSPACE
  ) {
    return E2B_WORKSPACE;
  }
  const relative = cwd.startsWith(`${E2B_WORKSPACE}/`)
    ? cwd.slice(E2B_WORKSPACE.length + 1)
    : cwd.startsWith("/home/rakazo/")
      ? cwd.slice("/home/rakazo/".length)
      : cwd;
  return workspacePath(E2B_WORKSPACE, relative);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
