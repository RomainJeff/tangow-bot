import type { ProcessEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerSandboxProvider,
  MAX_SANDBOX_ERROR_RESPONSE_BYTES,
  MAX_SANDBOX_SUCCESS_RESPONSE_BYTES,
  SCREEN_RELEASE_TIMEOUT_MS,
} from "./docker-sandbox.js";

const context = {
  operationId: "docker-test",
  traceId: "docker-test",
  spaceId: "workspace",
  userId: "user",
  botId: "bot",
  screenLeaseId: "run-1:1",
  signal: new AbortController().signal,
};

describe("Docker sandbox", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("describes the Docker provider", () => {
    expect(
      new DockerSandboxProvider("http://supervisor.test", "test-token").describe(),
    ).toMatchObject({ id: "docker", contractVersion: "1" });
  });

  it("reconnects to a live providerRef without creating a second Computer", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/computers/live-1")) return Response.json({ running: true });
      if (init?.method === "POST") return Response.json({ id: "created-1" });
      throw new Error("unexpected supervisor request");
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    await expect(
      provider.provision(
        { botId: "owner", homePath: "/data/homes/owner", providerRef: "live-1" },
        context,
      ),
    ).resolves.toMatchObject({ providerRef: "live-1", fresh: false });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("creates a replacement only after its providerRef is absent or stopped", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/computers/gone-1")) return new Response("gone", { status: 404 });
      if (init?.method === "POST") return Response.json({ id: "created-2" });
      throw new Error("unexpected supervisor request");
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    await expect(
      provider.provision(
        { botId: "owner", homePath: "/data/homes/owner", providerRef: "gone-1" },
        context,
      ),
    ).resolves.toMatchObject({ providerRef: "created-2", fresh: true });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("sends the bounded timeout to the supervisor and preserves its honest result", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        stdout: "partial output\n",
        stderr: "command timed out after 75 ms\n",
        code: 124,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const events: ProcessEvent[] = [];

    for await (const event of provider.execute(
      { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
      { argv: ["sleep", "10"], timeoutMs: 75 },
      context,
    )) {
      events.push(event);
    }

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      argv: ["sleep", "10"],
      cwd: "/home/rakazo",
      timeoutMs: 75,
    });
    expect(events).toEqual([
      { type: "stdout", data: "partial output\n" },
      { type: "stderr", data: "command timed out after 75 ms\n" },
      { type: "exit", code: 124 },
    ]);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-rakazo-bot-id": "bot",
      "x-rakazo-screen-id": "bot",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-request-id": expect.any(String),
      traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/),
    });
  });

  it.each([
    { status: 400, code: "schema_rejected", expected: "schema_rejected" },
    { status: 500, code: "private_files_failed", expected: "private_files_failed" },
    { status: 500, code: "exec_failed", expected: "exec_failed" },
    { status: 500, code: "private-env-value", expected: "unknown" },
  ])(
    "preserves only the safe native startup diagnostic $expected",
    async ({ status, code, expected }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ code, error: "private-env-value private-argv-value" }, { status }),
        ),
      );
      const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
      await expect(
        provider.startNativeProcess(
          { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
          {
            argv: ["claude", "private-argv-value"],
            cwd: ".",
            env: { FIXTURE_SECRET: "private-env-value" },
          },
          context,
        ),
      ).rejects.toMatchObject({
        code: "harness_unavailable",
        message: `native process unavailable (${status} ${expected})`,
      });
    },
  );

  it("hosts a bidirectional native process on the selected Computer supervisor route", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/native-processes")) return Response.json({ id: "native-1" });
      if (url.endsWith("/read")) return Response.json({ lines: ['{"id":1}\n'] });
      if (url.endsWith("/write")) return Response.json({ ok: true });
      if (init?.method === "DELETE")
        return Response.json({
          status: "stopped",
          terminal: {
            code: 143,
            signal: null,
            exitSource: "wrapper_exit_file",
            stderr: { present: false },
          },
        });
      throw new Error(`unexpected route ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const native = await provider.startNativeProcess!(
      { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
      { argv: ["codex", "app-server", "--listen", "stdio://"], cwd: "bots/bot", env: { CI: "1" } },
      context,
    );
    await native.write('{"jsonrpc":"2.0"}\n');
    expect((await native.stdout[Symbol.asyncIterator]().next()).value).toBe('{"id":1}\n');
    await expect(native.stop()).resolves.toBe("stopped");
    await expect(native.wait()).resolves.toMatchObject({
      code: 143,
      exitSource: "wrapper_exit_file",
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://supervisor.test/computers/computer/native-processes",
      "http://supervisor.test/computers/computer/native-processes/native-1/write",
      "http://supervisor.test/computers/computer/native-processes/native-1/read",
      "http://supervisor.test/computers/computer/native-processes/native-1",
    ]);
  });

  it("ends stdout and reports the real exit code after a native Computer process crashes", async () => {
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/native-processes")) return Response.json({ id: "native-crash" });
        if (url.endsWith("/read"))
          return Response.json(
            reads++ === 0
              ? { lines: ['{"id":1}\n'], terminal: { code: 23, signal: null } }
              : { lines: [], terminal: { code: 23, signal: null } },
          );
        if (init?.method === "DELETE") return Response.json({ status: "stopped" });
        throw new Error(`unexpected route ${url}`);
      }),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const native = await provider.startNativeProcess!(
      { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
      { argv: ["fixture"], cwd: "." },
      context,
    );
    const lines: string[] = [];
    for await (const line of native.stdout) lines.push(line);
    expect(lines).toEqual(['{"id":1}\n']);
    await expect(native.wait()).resolves.toEqual({ code: 23, signal: null });
  });

  it("surfaces a lost native transport as distinct from a process exit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/native-processes")) return Response.json({ id: "native-lost" });
        if (url.endsWith("/read"))
          return Response.json({ lines: [], streamLost: true, terminal: null });
        throw new Error(`unexpected route ${url}`);
      }),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const native = await provider.startNativeProcess!(
      { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
      { argv: ["fixture"], cwd: "." },
      context,
    );

    await expect(native.stdout[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "native_process_stream_lost",
    });
  });

  it("keeps cleanup failure observable to the native runtime", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/native-processes")) return Response.json({ id: "cleanup" });
        if (init?.method === "DELETE")
          return Response.json({ status: "stopped", cleanup: "failed" });
        throw new Error(`unexpected route ${url}`);
      }),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const native = await provider.startNativeProcess!(
      { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
      { argv: ["fixture"], cwd: "." },
      context,
    );
    await expect(native.stop()).resolves.toBe("stop_unconfirmed");
  });

  it("purges only the explicitly declared private home, whatever the runtime env names", async () => {
    const home = `/tmp/rakazo-tool-bot-${"a".repeat(64)}`;
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/native-processes")) return Response.json({ id: "home" });
      if (url.endsWith("/native-homes")) return Response.json({ cleanup: "removed" });
      throw new Error(`unexpected route ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const computer = {
      id: "computer",
      botId: "bot",
      kind: "docker",
      providerRef: "computer",
    } as const;
    const withHome = await provider.startNativeProcess!(
      computer,
      { argv: ["fixture"], cwd: ".", privateHome: home, env: { TOOL_HOME: home } },
      context,
    );
    await withHome.purgeHome!();
    const purge = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/native-homes"));
    expect(JSON.parse(String(purge?.[1]?.body))).toEqual({ home });

    const envOnly = await provider.startNativeProcess!(
      computer,
      { argv: ["fixture"], cwd: ".", env: { CODEX_HOME: home, CLAUDE_CONFIG_DIR: home } },
      context,
    );
    expect(envOnly.purgeHome).toBeUndefined();
  });

  it("rejects a declared oversized success response without buffering it", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            headers: { "content-length": String(MAX_SANDBOX_SUCCESS_RESPONSE_BYTES + 1) },
          }),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.provision({ botId: "bot", homePath: "/tmp/bot" }, context),
    ).rejects.toThrow(`sandbox response exceeds ${MAX_SANDBOX_SUCCESS_RESPONSE_BYTES} bytes`);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("translates a 429 computer limit reached error from the supervisor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "Computer limit reached for space (max: 5)" }, { status: 429 }),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.provision({ botId: "bot", homePath: "/tmp/bot" }, context),
    ).rejects.toThrow("Computer limit reached for space (max: 5)");
  });

  it("preserves absolute skill paths when listing and reading a mounted reference", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      String(_input).includes("mode=read") ? Response.json({ content: "" }) : Response.json([]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const computer = {
      id: "computer",
      botId: "bot",
      kind: "docker" as const,
      providerRef: "computer",
    };

    await provider.listFiles(computer, "/skills/user/example/references", context);
    await provider.readFile(computer, "/skills/user/example/references/reference.md", context);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "path=%2Fskills%2Fuser%2Fexample%2Freferences",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "path=%2Fskills%2Fuser%2Fexample%2Freferences%2Freference.md",
    );
  });

  it("stops a streamed file response at the caller-derived encoded limit", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(1029));
              },
              cancel,
            }),
          ),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.readFile(
        { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
        "small.txt",
        context,
        { maxBytes: 1 },
      ),
    ).rejects.toThrow("sandbox response exceeds 1028 bytes");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("accepts a valid encoded envelope above the generic response cap", async () => {
    const maxBytes = 13 * 1024 * 1024;
    const encodedLimit = Math.ceil(maxBytes / 3) * 4 + 1024;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"content":""}', {
            headers: { "content-length": String(encodedLimit) },
          }),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.readFile(
        { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
        "large.bin",
        context,
        { maxBytes },
      ),
    ).resolves.toEqual(new Uint8Array());
  });

  it("releases this bot's screen assignment through the supervisor", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await provider.releaseScreen(
      { id: "computer", botId: "home-bot", kind: "docker", providerRef: "computer" },
      context,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://supervisor.test/computers/computer/screen",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          authorization: "Bearer test-token",
          "x-rakazo-bot-id": "home-bot",
          "x-rakazo-screen-id": "bot",
          "x-rakazo-screen-lease-id": "run-1:1",
          "x-rakazo-space-id": "workspace",
        }),
      }),
    );
  });

  it("still releases the screen after the run abort signal has fired", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const abort = new AbortController();
    abort.abort();

    await expect(
      provider.releaseScreen(
        { id: "computer", botId: "home-bot", kind: "docker", providerRef: "computer" },
        { ...context, signal: abort.signal },
      ),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).not.toBe(abort.signal);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it("bounds screen release even when fetch ignores cancellation", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Promise<Response>(() => undefined),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    const pending = provider.releaseScreen(
      { id: "computer", botId: "home-bot", kind: "docker", providerRef: "computer" },
      context,
    );
    const rejected = expect(pending).rejects.toThrow("sandbox screen release timed out");
    await vi.advanceTimersByTimeAsync(SCREEN_RELEASE_TIMEOUT_MS);

    await rejected;
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("surfaces a supervisor failure from stop and destroy instead of swallowing it", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "stale-token");
    const computer = {
      id: "computer",
      botId: "bot",
      kind: "docker",
      providerRef: "computer",
    } as const;

    await expect(provider.stop(computer, context)).rejects.toThrow(
      'sandbox stop failed: 401 {"error":"unauthorized"}',
    );
    await expect(provider.destroy(computer, context)).rejects.toThrow(
      'sandbox destroy failed: 401 {"error":"unauthorized"}',
    );

    fetchMock.mockImplementation(async () => new Response("boom", { status: 500 }));
    await expect(provider.stop(computer, context)).rejects.toThrow("sandbox stop failed: 500 boom");
    await expect(provider.destroy(computer, context)).rejects.toThrow(
      "sandbox destroy failed: 500 boom",
    );
  });

  it("sends the user id so the supervisor can mount that user's skills", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ id: "computer", resumed: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await provider.provision({ botId: "bot", homePath: "/data/homes/bot" }, context);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      botId: "bot",
      homePath: "/data/homes/bot",
      spaceId: "workspace",
      userId: "user",
    });
  });

  it("does not buffer an oversized supervisor error body", async () => {
    const cancel = vi.fn();
    const fetchMock = vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          status: 500,
          headers: { "content-length": String(MAX_SANDBOX_ERROR_RESPONSE_BYTES + 1) },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const computer = {
      id: "computer",
      botId: "bot",
      kind: "docker",
      providerRef: "computer",
    } as const;

    await expect(provider.stop(computer, context)).rejects.toThrow("sandbox stop failed: 500");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("stops reading a streamed supervisor error at the byte limit", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_SANDBOX_ERROR_RESPONSE_BYTES + 1));
            },
          }),
          { status: 500 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.stop(
        { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
        context,
      ),
    ).rejects.toThrow("sandbox stop failed: 500");
  });

  it("treats a computer the supervisor no longer knows as already stopped and destroyed", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "computer not found" }, { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const computer = {
      id: "computer",
      botId: "bot",
      kind: "docker",
      providerRef: "computer",
    } as const;

    await expect(provider.stop(computer, context)).resolves.toBeUndefined();
    await expect(provider.destroy(computer, context)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("asks the supervisor to cancel orphaned run work when releasing a screen", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    await provider.releaseScreen(
      { id: "computer-1", botId: "bot", kind: "docker", providerRef: "computer-1" },
      { ...context, cancelRunWork: true },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://supervisor.test/computers/computer-1/screen",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "x-rakazo-cancel-run-work": "1" }),
      }),
    );
  });
});

describe("Docker page browser", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the owned computer screen and lease instead of the generic exec endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, title: "Fixture", url: "https://example.test" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    await provider.pageBrowser(
      { id: "computer", botId: "team-home", kind: "docker", providerRef: "computer" },
      { command: "snapshot" },
      context,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://supervisor.test/computers/computer/browser",
      expect.objectContaining({
        redirect: "error",
        signal: context.signal,
        body: JSON.stringify({ command: "snapshot" }),
        headers: expect.objectContaining({
          "x-rakazo-bot-id": "team-home",
          "x-rakazo-screen-lease-id": "run-1:1",
        }),
      }),
    );
  });
});
