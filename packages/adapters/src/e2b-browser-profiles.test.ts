import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef, PortableFile } from "@tangow/adapter-kit";
import { shellQuote } from "@tangow/core/node/desktop-runtime";
import { parse } from "shell-quote";
import { expect, it, onTestFinished, vi } from "vitest";
import { fakeE2BMachine } from "./e2b-machine.test-support.js";
import type { E2BSandboxSdk } from "./e2b-sandbox.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";
import { desktopCommandResponder } from "./linux-desktop.test-support.js";

const context = {
  operationId: "profile-test",
  traceId: "profile-test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
const computer: ComputerRef = {
  id: "machine",
  providerRef: "machine",
  kind: "e2b",
  botId: "team-space",
};

function sdkFor(machine: ReturnType<typeof fakeE2BMachine>) {
  return {
    connect: async () => machine.sandbox,
    create: async () => fakeE2BMachine("replacement").sandbox,
    pause: async () => undefined,
  } satisfies E2BSandboxSdk;
}

it.each([
  {
    home: "volumes",
    homeKey: "team-space",
    writableRoots: undefined,
    root: "/home/user/.browser-profiles/bot_a",
  },
  {
    home: "volumes",
    homeKey: "bot_a",
    writableRoots: ["bots/bot_a", "shared"],
    root: "/home/user/.browser-profiles/bot_a",
  },
  {
    home: "snapshot",
    homeKey: "team-space",
    writableRoots: undefined,
    root: "/home/user/rakazo-home/.browser-profiles",
  },
])(
  "keeps stable isolated profiles for $home / $homeKey",
  async ({ home, homeKey, writableRoots, root }) => {
    const machine = fakeE2BMachine("machine", {}, { home, botId: homeKey });
    const respond = desktopCommandResponder();
    const commands: string[] = [];
    machine.sandbox.commands.run = vi.fn(async (command: string) => {
      commands.push(command);
      return respond(command) ?? { stdout: "", stderr: "", exitCode: 0 };
    }) as unknown as typeof machine.sandbox.commands.run;
    const ref = { ...computer, botId: homeKey, ...(writableRoots ? { writableRoots } : {}) };
    const profileFor = async (provider: E2BSandboxProvider, botId: string) => {
      await provider.act(
        ref,
        { actions: [{ kind: "open", path: "https://example.test" }], observe: false },
        { ...context, botId },
      );
      const action = parse(commands.at(-1)!)[2];
      if (typeof action !== "string") throw new Error("expected a shell command");
      const result = spawnSync(
        "bash",
        ["-eu", "-c", `${action.split("\n")[0]}\nprintf %s "$CHROME_USER_DATA_DIR"`],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    const first = await profileFor(new E2BSandboxProvider("test-key", sdkFor(machine)), "bot_a");
    expect(first).toMatch(new RegExp(`^${root.replaceAll(".", "\\.")}/chromium-bot-[a-f0-9]{32}$`));
    expect(await profileFor(new E2BSandboxProvider("test-key", sdkFor(machine)), "bot_a")).toBe(
      first,
    );
    const second = await profileFor(new E2BSandboxProvider("test-key", sdkFor(machine)), "bot_b");
    expect(second).not.toBe(first);
    if (home === "volumes") expect(second).toMatch(/^\/home\/user\/\.browser-profiles\/bot_b\//);
  },
);

it("refuses a volume screen without a bot context instead of writing into the home key", async () => {
  const machine = fakeE2BMachine("machine", {}, { home: "volumes", botId: "team-space" });
  const respond = desktopCommandResponder();
  machine.sandbox.commands.run = vi.fn(
    async (command: string) => respond(command) ?? { stdout: "", stderr: "", exitCode: 0 },
  ) as unknown as typeof machine.sandbox.commands.run;
  const provider = new E2BSandboxProvider("test-key", sdkFor(machine));
  await expect(provider.observe(computer, context)).rejects.toMatchObject({
    name: "ComputerScreenUnavailableError",
  });
});

it.each(["export", "import", "archive"])(
  "quiesces all local and legacy profiles before %s without a bot context",
  async (operation) => {
    const root = await mkdtemp(path.join(tmpdir(), "e2b-profile-stop-"));
    const local = await mkdtemp(path.join(tmpdir(), "e2b-profile-local-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    onTestFinished(() => rm(local, { recursive: true, force: true }));
    const legacy = ".browser-profiles/chromium-bot-legacy";
    const profiles = [
      path.join(root, legacy),
      path.join(local, "bot_a/chromium-bot-a"),
      path.join(local, "bot_b/chromium-bot-b"),
    ];
    const files: Record<string, string> = {
      "project/Cache/keep": "project",
      "project/lock": "keep",
      [`${legacy}/Default/Cookies`]: "saved",
      [`${legacy}/Cache/transient`]: "cache",
      [`${legacy}/SingletonLock`]: "lock",
    };
    for (const profile of profiles) {
      await mkdir(path.join(profile, "Default"), { recursive: true });
      await symlink("absent-99999999", path.join(profile, "SingletonLock"));
      await writeFile(path.join(profile, "SingletonCookie"), "stale");
    }
    const machine = fakeE2BMachine("machine", files, { home: "volumes", botId: "team-space" });
    machine.sandbox.commands.run = vi.fn(async (command: string) => {
      const result = spawnSync(
        "bash",
        [
          "-eu",
          "-c",
          `flock() { :; }; export -f flock;\n${command}`
            .replaceAll("/home/user/rakazo-home", root)
            .replaceAll("/home/user/.browser-profiles", local)
            .replaceAll("/workspace", root)
            .replaceAll("/tmp/rakazo", `${root}/runtime`),
        ],
        { encoding: "utf8" },
      );
      if (result.status !== 0) throw new Error(result.stderr);
      for (const profile of profiles) {
        await expect(readFile(path.join(profile, "SingletonCookie"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }) as unknown as typeof machine.sandbox.commands.run;
    const provider = new E2BSandboxProvider("test-key", sdkFor(machine));
    const exported: PortableFile[] = [];
    if (operation === "import") {
      await provider.importWorkspace(computer, (async function* () {})(), context);
    } else if (operation === "export") {
      for await (const file of provider.exportWorkspace(computer, context)) exported.push(file);
    } else {
      await provider.provision(
        {
          botId: "team-space",
          homePath: "/unused",
          providerRef: "machine",
          providerKind: "e2b",
          volumeHome: {
            root: "/workspace",
            mounts: [],
            archive: async (stream) => {
              for await (const file of stream) exported.push(file);
            },
          },
        },
        context,
      );
    }
    expect(machine.sandbox.commands.run).toHaveBeenCalled();
    if (operation !== "import") {
      expect(exported.map((file) => file.path).sort()).toEqual([
        `${legacy}/Default/Cookies`,
        "project/Cache/keep",
        "project/lock",
      ]);
    }
  },
);

// Uses the existing offline computer image opt-in; no provider credentials or network.
it.skipIf(process.env.VERIFY_DOCKER_TEAM_SCREENS !== "1").each([
  { mode: "team", target: "/workspace", home: "volumes" },
  { mode: "dedicated", target: "/workspace/bots/bot_a", home: "volumes" },
  { mode: "historical alias", target: "/workspace/bots/bot_a", home: "snapshot" },
])(
  "runs and quiesces the generated $mode E2B desktop as UID/GID 1000 with a protected workspace",
  async ({ target, home }) => {
    const name = `rakazo-e2b-profiles-${randomUUID()}`;
    const docker = (...args: string[]) =>
      execFileSync("docker", args, { encoding: "utf8", timeout: 120_000 });
    try {
      docker(
        "run",
        "-d",
        "--name",
        name,
        "--network",
        "none",
        "--user",
        "0:0",
        "--entrypoint",
        "bash",
        process.env.RAKAZO_COMPUTER_IMAGE ?? "rakazo/computer:local",
        "-eu",
        "-c",
        [
          "mkdir -p /home/user /workspace/bots/bot_a /workspace/bots/bot_b /workspace/shared",
          "chown 1000:1000 /home/user /workspace/bots/bot_a /workspace/bots/bot_b /workspace/shared",
          "chown 0:0 /workspace /workspace/bots; chmod 755 /workspace /workspace/bots",
          `ln -s ${shellQuote(target)} /home/user/rakazo-home`,
          "exec sleep infinity",
        ].join("\n"),
      );
      const before = docker("exec", name, "stat", "-c", "%u:%g:%a", "/workspace").trim();
      expect(before).toBe("0:0:755");
      expect(docker("exec", "-u", "1000:1000", name, "id", "-u").trim()).toBe("1000");
      expect(docker("exec", "-u", "1000:1000", name, "id", "-g").trim()).toBe("1000");
      const run = async (command: string) => {
        try {
          return {
            stdout: docker("exec", "-u", "1000:1000", name, "bash", "-eu", "-c", command),
            stderr: "",
            exitCode: 0,
          };
        } catch (error) {
          throw new Error(error instanceof Error ? error.message : String(error));
        }
      };
      const machine = fakeE2BMachine("machine", {}, { home, botId: "team-space" });
      machine.sandbox.commands.run = vi.fn(run) as unknown as typeof machine.sandbox.commands.run;
      const provider = new E2BSandboxProvider("test-key", sdkFor(machine));
      for (const botId of ["bot_a", "bot_b", "bot_a"]) {
        expect(
          (await provider.observe(computer, { ...context, botId })).image.length,
        ).toBeGreaterThan(0);
      }
      const profiles = docker(
        "exec",
        name,
        "find",
        "/workspace/bots",
        "/home/user",
        "-name",
        "chromium-bot-*",
        "-type",
        "d",
      )
        .trim()
        .split("\n");
      expect(profiles).toHaveLength(2);
      expect(
        profiles.every((profile) =>
          home === "volumes"
            ? /^\/home\/user\/\.browser-profiles\/bot_[ab]\/chromium-bot-[a-f0-9]{32}$/.test(
                profile,
              )
            : /^\/workspace\/bots\/bot_a\/\.browser-profiles\/chromium-bot-[a-f0-9]{32}$/.test(
                profile,
              ),
        ),
      ).toBe(true);
      if (target === "/workspace") {
        const old = spawnSync(
          "docker",
          [
            "exec",
            "-u",
            "1000:1000",
            name,
            "mkdir",
            "-p",
            "/home/user/rakazo-home/.browser-profiles",
          ],
          { encoding: "utf8" },
        );
        expect(old.status).not.toBe(0);
        expect(old.stderr).toContain("Permission denied");
      }
      for (const profile of profiles)
        docker(
          "exec",
          "-u",
          "1000:1000",
          name,
          "bash",
          "-c",
          `printf saved >${shellQuote(profile)}/proof`,
        );
      if (home === "snapshot") {
        const mainPids = () =>
          docker("exec", name, "ps", "-eo", "pid=,args=")
            .split("\n")
            .filter((line) => line.includes("--user-data-dir=") && !line.includes("--type="))
            .map((line) => line.trim().split(/\s+/)[0]);
        const tracking = () =>
          docker("exec", name, "bash", "-c", "cat /tmp/rakazo/browser-pid-* | sort");
        const identity = () => docker("exec", name, "stat", "-Lc", "%d:%i", ...profiles);
        const pids = mainPids();
        const tracked = tracking();
        const inodes = identity();
        expect(pids).toHaveLength(2);
        const canonical = new E2BSandboxProvider("test-key", sdkFor(machine));
        await canonical.observe(
          { ...computer, writableRoots: [""] },
          { ...context, botId: "bot_a" },
        );
        expect(mainPids()).toEqual(pids);
        expect(tracking()).toBe(tracked);
        expect(identity()).toBe(inodes);
      }
      await provider.importWorkspace(computer, (async function* () {})(), context);
      expect(docker("exec", name, "ps", "-eo", "args")).not.toContain("--user-data-dir=");
      expect(
        docker(
          "exec",
          name,
          "find",
          "/tmp/rakazo",
          "-maxdepth",
          "1",
          "-name",
          "browser-pid-*",
          "-type",
          "f",
          "-print",
        ).trim(),
      ).toBe("");
      for (const profile of profiles) {
        expect(docker("exec", name, "cat", `${profile}/proof`)).toBe("saved");
        const lock = spawnSync("docker", ["exec", name, "test", "-e", `${profile}/SingletonLock`]);
        expect(lock.status).toBe(1);
      }
      expect(docker("exec", name, "stat", "-c", "%u:%g:%a", "/workspace").trim()).toBe(before);
    } finally {
      docker("rm", "-f", name);
    }
  },
  180_000,
);
