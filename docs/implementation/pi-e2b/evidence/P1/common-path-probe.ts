// One trial of the in-process home path that P1 touches: restore into a fresh machine, then
// checkpoint, for a snapshot home and for a Docker home on the local store.
// Usage: tsx common-path-probe.ts <checkout root> <trunk|head> <iterations>
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const [root, side, iterationsArg] = process.argv.slice(2);
assert(root && (side === "trunk" || side === "head"), "usage: <root> <trunk|head> <iterations>");
const iterations = Number(iterationsArg ?? "50");
const load = (file: string) =>
  import(pathToFileURL(path.join(root, "packages/adapters/src", file)).href);
const { restoreComputerWorkspace, checkpointComputerWorkspace } =
  await load("computer-workspace.ts");
const { FakeSandboxProvider } = await load("fake-sandbox.ts");
const { LocalAgentHomeStore } = await load("home.ts");

const context = {
  operationId: "p1-common-path",
  traceId: "p1-common-path",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
const homeKey = "bot-1";
const homeArg =
  side === "trunk" ? homeKey : { homeKey, homeStorage: "snapshot", homeRevision: "empty" };
const store = await mkdtemp(path.join(tmpdir(), "p1-common-path-"));
try {
  const home = new LocalAgentHomeStore(store);
  const seed = new FakeSandboxProvider();
  const seeded = await seed.provision({ botId: homeKey, homePath: store }, context);
  for (let file = 0; file < 40; file++) {
    await seed.writeFile(
      seeded,
      { path: `notes/${file}.txt`, content: new Uint8Array(4096).fill(file) },
      context,
    );
  }
  await checkpointComputerWorkspace(home, seed, homeArg, seeded, context);

  const samples = { snapshot: [] as number[], mounted: [] as number[] };
  for (let index = 0; index < iterations; index++) {
    const sandbox = new FakeSandboxProvider();
    const computer = await sandbox.provision({ botId: homeKey, homePath: store }, context);
    let started = performance.now();
    await restoreComputerWorkspace(home, sandbox, homeArg, computer, context);
    await checkpointComputerWorkspace(home, sandbox, homeArg, computer, context);
    samples.snapshot.push(performance.now() - started);
    const docker = { ...computer, kind: "docker" };
    started = performance.now();
    await restoreComputerWorkspace(home, sandbox, homeArg, docker, context);
    await checkpointComputerWorkspace(home, sandbox, homeArg, docker, context);
    samples.mounted.push(performance.now() - started);
  }
  const median = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  process.stdout.write(
    `${JSON.stringify({ side, snapshotMs: median(samples.snapshot), mountedMs: median(samples.mounted) })}\n`,
  );
} finally {
  await rm(store, { recursive: true, force: true });
}
