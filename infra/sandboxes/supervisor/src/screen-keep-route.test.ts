import { Readable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core";
import { screenPorts } from "@rakazo/core/node/desktop-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ exec: vi.fn(), inspect: vi.fn() }));
vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return mock;
    }
  },
}));

import { supervisorApp } from "./index.js";
import { interactiveScreenCommand, stopExtraScreenCommand } from "./supervisor-logic.js";

type Exec = (command: string) => Promise<number> | number;

function runCommands(exec: Exec) {
  mock.exec.mockImplementation(async (options: { Cmd: string[] }) => {
    let code = 0;
    return {
      start: async () => {
        code = await exec(options.Cmd.at(-1) ?? "");
        return Readable.from([Buffer.from("")]);
      },
      inspect: async () => ({ ExitCode: code }),
    };
  });
}

beforeEach(() => {
  mock.exec.mockReset();
  mock.inspect.mockReset();
  mock.inspect.mockResolvedValue({
    Config: {
      Labels: { "rakazo.managed": "true", "rakazo.botId": "home", "rakazo.spaceId": "space" },
    },
  });
  runCommands(() => 0);
});

function headers(extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
    "content-type": "application/json",
    "x-rakazo-bot-id": "home",
    "x-rakazo-space-id": "space",
    "x-rakazo-screen-id": "writer",
    ...extra,
  };
}

async function claim(computer: string, lease: string) {
  await supervisorApp.request(`/computers/${computer}/browser`, {
    method: "POST",
    headers: headers({ "x-rakazo-screen-lease-id": lease }),
    body: JSON.stringify({ command: "snapshot" }),
  });
}

async function release(computer: string, extra: Record<string, string>) {
  const calls = mock.exec.mock.calls.length;
  const response = await supervisorApp.request(`/computers/${computer}/screen`, {
    method: "DELETE",
    headers: headers(extra),
  });
  const commands = mock.exec.mock.calls
    .slice(calls)
    .map(([options]) => (options as { Cmd: string[] }).Cmd.at(-1));
  return { response, commands };
}

const teardown = stopExtraScreenCommand(0, "writer");
const keep = {
  "x-rakazo-screen-lease-id": "run-1:1",
  "x-rakazo-preserve-screen": "1",
};

describe("releasing a screen to keep it", () => {
  it("revokes control and leaves the display and browser running", async () => {
    await claim("keep-leased", "run-1:1");

    const { response, commands } = await release("keep-leased", keep);

    expect(await response.json()).toEqual({ ok: true, kept: true });
    expect(commands).toEqual([interactiveScreenCommand(false, undefined, screenPorts(0))]);
    expect(commands).not.toContain(teardown);
  });

  it("tears down when the release cancels the run's work", async () => {
    await claim("keep-cancel", "run-1:1");

    const { response, commands } = await release("keep-cancel", {
      ...keep,
      "x-rakazo-cancel-run-work": "1",
    });

    expect(await response.json()).toEqual({ ok: true });
    expect(commands).toEqual([teardown]);
  });

  it("tears down a release that carries no lease", async () => {
    await claim("keep-no-lease", "run-1:1");

    const { response, commands } = await release("keep-no-lease", {
      "x-rakazo-preserve-screen": "1",
    });

    expect(await response.json()).toEqual({ ok: true });
    expect(commands).toEqual([teardown]);
  });

  it("tears down when revoking control exits non-zero", async () => {
    await claim("keep-revoke-fails", "run-1:1");
    runCommands((command) => (command === teardown ? 0 : 1));

    const { response, commands } = await release("keep-revoke-fails", keep);

    expect(await response.json()).toEqual({ ok: true });
    expect(commands.at(-1)).toBe(teardown);
  });

  it("tears down when revoking control throws", async () => {
    await claim("keep-revoke-throws", "run-1:1");
    runCommands((command) => {
      if (command !== teardown) throw new Error("docker unreachable");
      return 0;
    });

    const { response, commands } = await release("keep-revoke-throws", keep);

    expect(await response.json()).toEqual({ ok: true });
    expect(commands.at(-1)).toBe(teardown);
  });

  it("answers a release a newer run owns as refused, without stopping anything", async () => {
    await claim("keep-refused", "run-2:1");

    const { response, commands } = await release("keep-refused", keep);

    expect(await response.json()).toEqual({ ok: true, released: false });
    expect(commands).toEqual([]);
  });

  it("answers a release of a screen that is already gone as plain success", async () => {
    const { response, commands } = await release("keep-gone", keep);

    expect(await response.json()).toEqual({ ok: true });
    expect(commands).toEqual([]);
  });
});
