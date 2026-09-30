import path from "node:path";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  NativeProcess,
  NativeProcessRequest,
  PageBrowserCommand,
  PageBrowserResult,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs, resolveSupervisorToken } from "@rakazo/core";
import { outgoingCorrelationHeaders } from "@rakazo/logging";
import {
  boundedComputerActions,
  clampRounded,
  computerObservation,
  normalizeWorkspacePath,
} from "./computer-support.js";
import { writeJ2ProvisioningDiagnostic } from "./j2-provisioning-diagnostics.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

export const MAX_SANDBOX_ERROR_RESPONSE_BYTES = 8 * 1024;
export const MAX_SANDBOX_SUCCESS_RESPONSE_BYTES = 16 * 1024 * 1024;
export const SCREEN_RELEASE_TIMEOUT_MS = 8_000;
const SANDBOX_ERROR_RESPONSE_TIMEOUT_MS = 1_000;
const SANDBOX_SUCCESS_RESPONSE_TIMEOUT_MS = 30_000;

async function safeBody(res: Response, signal?: AbortSignal, maxChars = 200): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_SANDBOX_ERROR_RESPONSE_BYTES) {
    cancelResponseBody(res);
    return "";
  }
  try {
    const readSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(SANDBOX_ERROR_RESPONSE_TIMEOUT_MS)])
      : AbortSignal.timeout(SANDBOX_ERROR_RESPONSE_TIMEOUT_MS);
    const bytes = await readBodyCapped(res, MAX_SANDBOX_ERROR_RESPONSE_BYTES, readSignal);
    return new TextDecoder().decode(bytes).slice(0, maxChars);
  } catch {
    return "";
  }
}

function cancelResponseBody(res: Response): void {
  try {
    void Promise.resolve(res.body?.cancel()).catch(() => undefined);
  } catch {
    // Error diagnostics are best-effort and must not delay the operation failure.
  }
}

async function readSandboxJson<T>(
  res: Response,
  signal: AbortSignal,
  maxBytes = MAX_SANDBOX_SUCCESS_RESPONSE_BYTES,
): Promise<T> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    cancelResponseBody(res);
    throw new Error(`sandbox response exceeds ${maxBytes} bytes`);
  }
  const readSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(SANDBOX_SUCCESS_RESPONSE_TIMEOUT_MS),
  ]);
  let bytes: Uint8Array;
  try {
    bytes = await readBodyCapped(res, maxBytes, readSignal);
  } catch (error) {
    if (error instanceof Error && error.message === "Response is too large") {
      throw new Error(`sandbox response exceeds ${maxBytes} bytes`, { cause: error });
    }
    throw error;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function encodedFileResponseLimit(maxBytes: number | undefined): number {
  if (maxBytes === undefined) return MAX_SANDBOX_SUCCESS_RESPONSE_BYTES;
  // An explicit file limit is already the caller's memory-safety contract.
  // Account for base64 expansion plus the small JSON envelope without applying
  // the generic response cap, which would reject valid files above ~12 MiB.
  return Math.ceil(maxBytes / 3) * 4 + 1024;
}

/** Keep only the documented, read-only skill mount paths absolute over the wire. */
function sandboxFilePath(value: string): string {
  if (
    value === "/skills/user" ||
    value.startsWith("/skills/user/") ||
    value === "/skills/marketplaces" ||
    value.startsWith("/skills/marketplaces/")
  ) {
    return value;
  }
  return normalizeWorkspacePath(value);
}

export class DockerSandboxProvider implements SandboxProvider {
  private readonly supervisorToken: string;

  constructor(
    private readonly supervisorUrl: string,
    supervisorToken?: string,
  ) {
    this.supervisorToken = supervisorToken ?? resolveSupervisorToken(process.env);
  }

  describe() {
    return {
      id: "docker",
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

  async reconfirmNativeProcess(computer: ComputerRef, processRef: string, context: AdapterContext) {
    const response = await fetch(
      this.url(`/computers/${computer.id}/native-processes/${processRef}/reconfirm`),
      { method: "POST", headers: this.headers(context, computer.botId), signal: context.signal },
    );
    if (!response.ok)
      throw Object.assign(new Error("native process unavailable"), { code: "harness_unavailable" });
    return (
      await readSandboxJson<{ status: "stopped" | "stop_unconfirmed" }>(response, context.signal)
    ).status;
  }

  private url(path: string) {
    return `${this.supervisorUrl.replace(/\/$/, "")}${path}`;
  }

  private headers(context: AdapterContext, botId?: string) {
    return {
      authorization: `Bearer ${this.supervisorToken}`,
      "x-rakazo-space-id": context.spaceId,
      ...outgoingCorrelationHeaders(),
      ...(botId ? { "x-rakazo-bot-id": botId } : {}),
      ...(context.botId ? { "x-rakazo-screen-id": context.botId } : {}),
      ...(context.screenLeaseId ? { "x-rakazo-screen-lease-id": context.screenLeaseId } : {}),
      ...(context.cancelRunWork ? { "x-rakazo-cancel-run-work": "1" } : {}),
    };
  }

  async provision(
    request: { botId: string; homePath: string; providerRef?: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    if (request.providerRef) {
      const existing = await fetch(this.url(`/computers/${request.providerRef}`), {
        headers: this.headers(context, request.botId),
        signal: context.signal,
      });
      if (existing.ok) {
        const inspected = await readSandboxJson<{ running?: boolean }>(existing, context.signal);
        if (inspected.running) {
          return {
            id: request.providerRef,
            botId: request.botId,
            kind: "docker",
            providerRef: request.providerRef,
            fresh: false,
          };
        }
      }
    }
    const res = await fetch(this.url("/computers"), {
      method: "POST",
      headers: { ...this.headers(context, request.botId), "content-type": "application/json" },
      body: JSON.stringify({
        botId: request.botId,
        homePath: request.homePath,
        spaceId: context.spaceId,
        userId: context.userId,
      }),
      signal: context.signal,
    });
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      // Match team-screen style: regex on safeBody (already ≤200 chars), not JSON.parse.
      const limitError = detail.match(/Computer limit reached for space \(max: \d+\)/i)?.[0];
      if (res.status === 429 && limitError) {
        throw new Error(limitError);
      }
      throw new Error(`sandbox provision failed: ${res.status} ${detail}`.trim());
    }
    const body = await readSandboxJson<{ id: string; resumed?: boolean }>(res, context.signal);
    return {
      id: body.id,
      botId: request.botId,
      kind: "docker",
      providerRef: body.id,
      fresh: body.resumed !== true,
    };
  }

  async prepare(_computer: ComputerRef, _context: AdapterContext): Promise<void> {}

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const diagnosticStartedAt = Date.now();
    const diagnose = (
      step: string,
      extra: Record<string, string | number | boolean | undefined> = {},
    ) =>
      writeJ2ProvisioningDiagnostic({
        step,
        computerId: computer.id,
        botId: computer.botId,
        ms: Date.now() - diagnosticStartedAt,
        ...extra,
      });
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    await diagnose("docker_execute.fetch.before", { timeoutMs });
    let events = 0;
    let exitReceived = false;
    try {
      const res = await fetch(this.url(`/computers/${computer.id}/exec`), {
        method: "POST",
        headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
        body: JSON.stringify({
          ...request,
          cwd: dockerCwd(request.cwd),
          timeoutMs,
        }),
        signal: context.signal,
      });
      await diagnose("docker_execute.fetch.after", { status: res.status });
      if (!res.ok) {
        events += 1;
        yield { type: "stderr", data: `exec failed: ${res.status}` };
        events += 1;
        exitReceived = true;
        yield { type: "exit", code: 1 };
        await diagnose("docker_execute.after", { events, exitReceived });
        return;
      }
      const body = await readSandboxJson<{ stdout: string; stderr: string; code: number }>(
        res,
        context.signal,
      );
      await diagnose("docker_execute.body.after");
      if (body.stdout) {
        events += 1;
        yield { type: "stdout", data: body.stdout };
      }
      if (body.stderr) {
        events += 1;
        yield { type: "stderr", data: body.stderr };
      }
      events += 1;
      exitReceived = true;
      yield { type: "exit", code: body.code };
      await diagnose("docker_execute.after", { events, exitReceived });
    } catch (error) {
      await diagnose("docker_execute.catch", {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        events,
        exitReceived,
      });
      throw error;
    }
  }

  async startNativeProcess(
    computer: ComputerRef,
    request: NativeProcessRequest,
    context: AdapterContext,
  ): Promise<NativeProcess> {
    const created = await fetch(this.url(`/computers/${computer.id}/native-processes`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: context.signal,
    });
    if (!created.ok) {
      let code = "unknown";
      try {
        const diagnostic = JSON.parse(
          await safeBody(created, context.signal, MAX_SANDBOX_ERROR_RESPONSE_BYTES),
        );
        if (["schema_rejected", "private_files_failed", "exec_failed"].includes(diagnostic?.code))
          code = diagnostic.code;
      } catch {
        /* Never expose an untrusted error body. */
      }
      throw Object.assign(new Error(`native process unavailable (${created.status} ${code})`), {
        code: "harness_unavailable",
      });
    }
    const { id } = await readSandboxJson<{ id: string }>(created, context.signal);
    let stopped = false;
    let resolveTerminal!: (
      value: NativeProcess["wait"] extends () => Promise<infer T> ? T : never,
    ) => void;
    const terminal = new Promise<NativeProcess["wait"] extends () => Promise<infer T> ? T : never>(
      (resolve) => {
        resolveTerminal = resolve;
      },
    );
    const provider = this;
    async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
      const response = await fetch(path, init);
      if (!response.ok)
        throw Object.assign(new Error("native process unavailable"), {
          code: "harness_unavailable",
        });
      return response.json() as Promise<T>;
    }
    const headers = {
      ...this.headers(context, computer.botId),
      "content-type": "application/json",
    };
    const privateHome = request.privateHome;
    const read = async function* () {
      while (!stopped) {
        const result = await requestJson<{
          lines: string[];
          streamLost?: boolean;
          terminal: (NativeProcess["wait"] extends () => Promise<infer T> ? T : never) | null;
        }>(provider.url(`/computers/${computer.id}/native-processes/${id}/read`), {
          method: "POST",
          headers,
          signal: context.signal,
        });
        for (const line of result.lines) yield line;
        if (result.streamLost) {
          throw Object.assign(new Error("native process stream lost before wrapper exit"), {
            code: "native_process_stream_lost",
          });
        }
        if (result.terminal) {
          resolveTerminal(result.terminal);
          return;
        }
      }
    };
    return {
      id,
      stdout: read(),
      stderr: (async function* () {})(),
      write: async (data) => {
        await requestJson(this.url(`/computers/${computer.id}/native-processes/${id}/write`), {
          method: "POST",
          headers,
          body: JSON.stringify({ data }),
          signal: context.signal,
        });
      },
      wait: async () => terminal,
      stop: async () => {
        if (stopped) return "stopped" as const;
        stopped = true;
        const result = await requestJson<{
          status: "stopped" | "stop_unconfirmed";
          cleanup?: "removed" | "not_requested" | "failed" | "deferred";
          terminal?: NativeProcess["wait"] extends () => Promise<infer T> ? T : never;
        }>(this.url(`/computers/${computer.id}/native-processes/${id}`), {
          method: "DELETE",
          headers,
        });
        if (result.status === "stop_unconfirmed" || result.cleanup === "failed") {
          resolveTerminal({
            code: null,
            signal: null,
            exitSource: "unknown",
            stderr: { present: false },
          });
          return "stop_unconfirmed" as const;
        }
        if (result.terminal) resolveTerminal(result.terminal);
        return "stopped" as const;
      },
      ...(privateHome
        ? {
            purgeHome: async () => {
              await requestJson<{ cleanup: "removed" }>(
                provider.url(`/computers/${computer.id}/native-homes`),
                {
                  method: "DELETE",
                  headers,
                  body: JSON.stringify({ home: privateHome }),
                  signal: context.signal,
                },
              );
            },
          }
        : {}),
    };
  }

  async pageBrowser(
    computer: ComputerRef,
    request: PageBrowserCommand,
    context: AdapterContext,
  ): Promise<PageBrowserResult> {
    const res = await fetch(this.url(`/computers/${computer.id}/browser`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify(request),
      redirect: "error",
      signal: context.signal,
    });
    if (!res.ok) throw new Error(`page browser failed: ${res.status}`);
    return readSandboxJson<PageBrowserResult>(res, context.signal, 512 * 1024);
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    const res = await fetch(this.url(`/computers/${computer.id}/screen-mode`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({
        interactive: request.interactive === true,
        controlToken: request.controlToken,
        revokeControl: false,
      }),
      signal: context.signal,
    });
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      if (/cannot allocate another screen/i.test(detail)) {
        throw new Error("This Team Computer cannot allocate another screen.");
      }
      return { url: null, mimeType: "text/html", close: async () => undefined };
    }
    const body = await readSandboxJson<{ screenUrl?: string }>(res, context.signal);
    return {
      url: body.screenUrl ?? this.url(`/computers/${computer.id}/screen`),
      mimeType: "text/html",
      close: async () => undefined,
    };
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    const res = await fetch(this.url(`/computers/${computer.id}/screen-mode`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({ interactive, controlToken }),
      signal: context.signal,
    });
    if (!res.ok) throw new Error(`sandbox screen mode failed: ${res.status}`);
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    const res = await fetch(this.url(`/computers/${computer.id}/input`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({ input, leaseId: lease.leaseId }),
      signal: context.signal,
    });
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      throw new Error(`sandbox input failed: ${res.status} ${detail}`.trim());
    }
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const res = await fetch(this.url(`/computers/${computer.id}/observe`), {
      method: "POST",
      headers: this.headers(context, computer.botId),
      signal: context.signal,
    });
    if (!res.ok)
      throw new Error(
        `sandbox observation failed: ${res.status} ${await safeBody(res, context.signal)}`.trim(),
      );
    const body = await readSandboxJson<{
      image: string;
      mimeType: "image/png" | "image/jpeg";
      width: number;
      height: number;
      cursor?: { x: number; y: number };
      activeWindow?: { id: string; title?: string };
    }>(res, context.signal);
    return computerObservation(Uint8Array.from(Buffer.from(body.image, "base64")), {
      mimeType: body.mimeType,
      width: body.width,
      height: body.height,
      cursor: body.cursor,
      activeWindow: body.activeWindow,
    });
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    const actions = boundedComputerActions(request.actions);
    const res = await fetch(this.url(`/computers/${computer.id}/actions`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({
        actions,
        observe: request.observe,
        settleMs: clampRounded(request.settleMs ?? 0, 0, 5_000),
      }),
      signal: context.signal,
    });
    if (!res.ok)
      throw new Error(
        `sandbox action failed: ${res.status} ${await safeBody(res, context.signal)}`.trim(),
      );
    const body = await readSandboxJson<{
      completed: number;
      observation?: {
        image: string;
        mimeType: "image/png" | "image/jpeg";
        width: number;
        height: number;
        cursor?: { x: number; y: number };
        activeWindow?: { id: string; title?: string };
      };
    }>(res, context.signal);
    return {
      completed: body.completed,
      ...(body.observation
        ? {
            observation: computerObservation(
              Uint8Array.from(Buffer.from(body.observation.image, "base64")),
              body.observation,
            ),
          }
        : {}),
    };
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const path = sandboxFilePath(directory);
    const res = await fetch(
      this.url(`/computers/${computer.id}/files?path=${encodeURIComponent(path)}&mode=list`),
      { headers: this.headers(context, computer.botId), signal: context.signal },
    );
    if (!res.ok) throw new Error(`sandbox file listing failed: ${res.status}`);
    return readSandboxJson<ComputerFileEntry[]>(res, context.signal);
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const path = sandboxFilePath(filePath);
    const maxBytes = options?.maxBytes;
    const res = await fetch(
      this.url(
        `/computers/${computer.id}/files?path=${encodeURIComponent(path)}&mode=read${maxBytes === undefined ? "" : `&maxBytes=${maxBytes}`}`,
      ),
      { headers: this.headers(context, computer.botId), signal: context.signal },
    );
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      throw new Error(`sandbox file read failed: ${res.status} ${detail}`.trim());
    }
    const body = await readSandboxJson<{ content: string }>(
      res,
      context.signal,
      encodedFileResponseLimit(maxBytes),
    );
    return Uint8Array.from(Buffer.from(body.content, "base64"));
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const res = await fetch(this.url(`/computers/${computer.id}/files`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({
        path: normalizeWorkspacePath(file.path),
        content: Buffer.from(file.content).toString("base64"),
        executable: file.executable === true,
      }),
      signal: context.signal,
    });
    if (!res.ok) throw new Error(`sandbox file write failed: ${res.status}`);
  }

  async *exportWorkspace(computer: ComputerRef, context: AdapterContext) {
    yield* this.walkWorkspace(computer, "", context);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    for await (const file of files) await this.writeFile(computer, file, context);
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    return { id: `docker-snap-${computer.id}`, createdAt: new Date().toISOString() };
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    if (!context.botId) return;
    // Run cancellation must not skip cleanup, but cleanup still needs its own deadline.
    const deadline = requestDeadline(SCREEN_RELEASE_TIMEOUT_MS, "sandbox screen release timed out");
    try {
      const res = await withAbort(
        fetch(this.url(`/computers/${computer.id}/screen`), {
          method: "DELETE",
          headers: this.headers(context, computer.botId),
          signal: deadline.signal,
        }),
        deadline.signal,
      );
      if (!res.ok && res.status !== 404) {
        throw new Error(`sandbox screen release failed: ${res.status}`);
      }
    } finally {
      deadline.dispose();
    }
  }

  async stop(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const res = await fetch(this.url(`/computers/${computer.id}/stop`), {
      method: "POST",
      headers: this.headers(context, computer.botId),
      signal: context.signal,
    });
    // 404 means the supervisor no longer has the container, which is the state we want.
    if (!res.ok && res.status !== 404) {
      throw new Error(
        `sandbox stop failed: ${res.status} ${await safeBody(res, context.signal)}`.trim(),
      );
    }
  }

  async destroy(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const res = await fetch(this.url(`/computers/${computer.id}`), {
      method: "DELETE",
      headers: this.headers(context, computer.botId),
      signal: context.signal,
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(
        `sandbox destroy failed: ${res.status} ${await safeBody(res, context.signal)}`.trim(),
      );
    }
  }

  private async *walkWorkspace(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const entries = await this.listFiles(computer, directory, context);
    for (let index = 0; index < entries.length; ) {
      const entry = entries[index]!;
      if (entry.kind === "dir") {
        yield* this.walkWorkspace(computer, entry.path, context);
        index += 1;
        continue;
      }
      const files = [];
      while (index < entries.length && entries[index]?.kind === "file" && files.length < 8) {
        files.push(entries[index]!);
        index += 1;
      }
      const batch = await Promise.all(
        files.map(async (file) => ({
          path: file.path,
          content: await this.readFile(computer, file.path, context),
          executable: file.executable,
        })),
      );
      for (const file of batch) yield file;
    }
  }
}

function requestDeadline(timeoutMs: number, message: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
    },
  };
}

function dockerCwd(cwd: string | undefined) {
  if (!cwd || cwd === "." || cwd === "/" || cwd === "/home/rakazo") return "/home/rakazo";
  const relative = cwd.startsWith("/home/rakazo/")
    ? cwd.slice("/home/rakazo/".length)
    : normalizeWorkspacePath(cwd);
  return path.posix.join("/home/rakazo", relative);
}
