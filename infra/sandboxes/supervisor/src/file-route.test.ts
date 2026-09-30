import { Readable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core";
import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ exec: vi.fn(), inspect: vi.fn() }));
vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return mock;
    }
  },
}));

import { supervisorApp } from "./index.js";

beforeEach(() => {
  mock.exec.mockReset();
  mock.inspect.mockReset();
  mock.inspect.mockResolvedValue({
    Config: {
      Labels: { "rakazo.managed": "true", "rakazo.botId": "home", "rakazo.spaceId": "space" },
    },
  });
});

function files(path: string, mode: "list" | "read") {
  return supervisorApp.request(
    `/computers/computer/files?path=${encodeURIComponent(path)}&mode=${mode}`,
    {
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "x-rakazo-bot-id": "home",
        "x-rakazo-space-id": "space",
      },
    },
  );
}

it("returns an absolute mounted list entry that read accepts unchanged", async () => {
  mock.exec.mockImplementation(async (options: { Cmd: string[] }) => ({
    start: async () =>
      Readable.from([
        Buffer.from(
          options.Cmd[2]?.includes("os.scandir")
            ? JSON.stringify([
                { path: "skills/user/example/references/ref.md", kind: "file", size: 5 },
              ])
            : Buffer.from("hello").toString("base64"),
        ),
      ]),
    inspect: async () => ({ ExitCode: 0 }),
  }));

  const listed = (await (await files("/skills/user/example/references", "list")).json()) as Array<{
    path: string;
    kind: string;
    size: number;
  }>;
  expect(listed).toEqual([
    { path: "/skills/user/example/references/ref.md", kind: "file", size: 5 },
  ]);
  const read = await (await files(listed[0]!.path, "read")).json();
  expect(read).toEqual({ content: Buffer.from("hello").toString("base64") });
  expect(mock.exec.mock.calls[0]?.[0].Cmd).toContain("/skills/user/example/references");
  expect(mock.exec.mock.calls[1]?.[0].Cmd).toContain("/skills/user/example/references/ref.md");
});

it("keeps non-skill reads in the workspace and rejects realpath containment failures", async () => {
  mock.exec.mockImplementation(async () => ({
    start: async () => Readable.from([Buffer.from("outside mount")]),
    inspect: async () => ({ ExitCode: 43 }),
  }));

  expect((await files("notes/result.txt", "read")).status).toBe(404);
  expect((await files("/skills/user/link-out", "read")).status).toBe(404);
  expect((await files("/skills/user/link-out", "list")).status).toBe(404);
  expect(mock.exec.mock.calls[0]?.[0].Cmd).toContain("/home/rakazo/notes/result.txt");
  for (const call of mock.exec.mock.calls.slice(1)) {
    expect(call[0].Cmd.join("\n")).toContain("os.path.realpath");
  }
});
