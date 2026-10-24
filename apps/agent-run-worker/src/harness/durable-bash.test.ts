import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { durableBashTool } from "./durable-bash.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function mount() {
  const cwd = await mkdtemp(path.join(tmpdir(), "rakazo-bash-"));
  dirs.push(cwd);
  return cwd;
}

/** What the model reads, and where the whole output is kept when it was cut. */
async function bash(cwd: string, command: string) {
  const result = await durableBashTool(cwd, cwd).execute(
    randomUUID(),
    { command },
    undefined,
    undefined,
    undefined as never,
  );
  const [part] = result.content;
  return {
    text: part?.type === "text" ? part.text : "",
    spoolPath: (result.details as { fullOutputPath?: string } | undefined)?.fullOutputPath,
  };
}

const spoolName = () => `.rakazo-bash-${randomUUID()}.log`;
const spoolFiles = async (cwd: string) =>
  (await readdir(cwd)).filter((name) => name.startsWith(".rakazo-bash-"));

describe("native bash", () => {
  it("shows the model the first and last lines of a long output and keeps the whole of it on the mount", async () => {
    const cwd = await mount();

    const output = await bash(cwd, "seq 1 3000");
    const lines = output.text.split("\n");

    expect(lines.slice(0, 2)).toEqual(["1", "2"]);
    expect(lines.slice(-2)).toEqual(["2999", "3000"]);
    expect(lines.length).toBeLessThanOrEqual(2000);
    expect(output.text).toContain(
      `[output truncated: 13893 bytes in total, it is in ${output.spoolPath}]`,
    );
    expect(await readFile(output.spoolPath!, "utf8")).toBe(
      `${Array.from({ length: 3000 }, (_, i) => i + 1).join("\n")}\n`,
    );
  });

  it("stops keeping output at 16 MiB but still counts every byte", async () => {
    const cwd = await mount();

    const output = await bash(cwd, "head -c 20971520 /dev/zero | tr '\\0' 'a'");

    expect((await stat(output.spoolPath!)).size).toBe(16 * 1024 * 1024);
    expect(output.text.length).toBeLessThanOrEqual(12_000);
    expect(output.text).toContain(
      `[output truncated: 20971520 bytes in total, its first 16777216 bytes are in`,
    );
  });

  it("keeps the newest output files and leaves the bot's other files alone", async () => {
    const cwd = await mount();
    const old = Array.from({ length: 16 }, spoolName);
    for (const [index, name] of old.entries()) {
      await writeFile(path.join(cwd, name), "old");
      await utimes(path.join(cwd, name), 1_000 + index, 1_000 + index);
    }
    await writeFile(path.join(cwd, "notes.txt"), "mine");

    const output = await bash(cwd, "seq 1 3000");

    expect((await readdir(cwd)).sort()).toEqual(
      [...old.slice(1), path.basename(output.spoolPath!), "notes.txt"].sort(),
    );
  });

  it("never prunes the output file of a command still running", async () => {
    const cwd = await mount();
    const old = Array.from({ length: 16 }, spoolName);
    for (const name of old) await writeFile(path.join(cwd, name), "old");
    const release = path.join(cwd, "release");
    const running = bash(cwd, `seq 1 3000; while [ ! -e ${release} ]; do sleep 0.05; done`);
    await waitFor(async () =>
      (await spoolFiles(cwd)).some((name) => !old.includes(name)) ? 1 : 0,
    );
    // The running command's file is now the oldest: the next command must still leave it.
    const later = new Date(Date.now() + 60_000);
    for (const name of await spoolFiles(cwd)) {
      if (old.includes(name)) await utimes(path.join(cwd, name), later, later);
    }

    await bash(cwd, "seq 1 3000");
    await writeFile(release, "");
    const output = await running;

    expect(await readFile(output.spoolPath!, "utf8")).toBe(
      `${Array.from({ length: 3000 }, (_, i) => i + 1).join("\n")}\n`,
    );
  });
});

async function waitFor(read: () => Promise<number>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}
