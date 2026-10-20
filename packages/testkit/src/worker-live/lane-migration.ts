import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkerLifecycle, LocalAgentHomeStore, moveHomeToVolumes } from "@rakazo/adapters";
import { volumeMountPath } from "@rakazo/core";
import type { Sandbox } from "e2b";
import { startWorkerRun } from "../worker-run-fixture.js";
import { context, type Lane, sh, sha256 } from "./session.js";

/** A team home of two bots: shared files, each bot's files, an executable and a private key file. */
function syntheticHome(bots: [string, string]) {
  return [
    { path: "shared/readme.md", content: "# Team notes\n", mode: 0o644 },
    { path: "shared/data/table.csv", content: "a,b\n1,2\n", mode: 0o644 },
    { path: `bots/${bots[0]}/notes.md`, content: "first bot\n", mode: 0o644 },
    { path: `bots/${bots[0]}/bin/run.sh`, content: "#!/bin/sh\necho run\n", mode: 0o755 },
    { path: `bots/${bots[1]}/secret.txt`, content: "synthetic secret\n", mode: 0o600 },
    { path: `bots/${bots[1]}/deep/a/b/c.txt`, content: "deep\n", mode: 0o640 },
  ];
}

export const laneH: Lane = {
  id: "h",
  issue: "migration hashes et recréation computer",
  scenario:
    "#241's move of a synthetic team home (two bots, shared files, modes 0755/0640/0600) onto real E2B volumes: dry run, move, hash check, then two fresh computer VMs on the volumes, a second move, and a second team computer of the same space",
  passWhen:
    "The dry run creates nothing; the move adopts; every file on the volumes matches the manifest's hash and mode; recreated computers see the same files and keep a file written between them; a second move changes nothing; the second team computer's home is refused",
  async run(live) {
    const run = await startWorkerRun({ steps: [] });
    const dir = await mkdtemp(path.join(tmpdir(), "rakazo-live-home-"));
    const files = live.volumeFiles();
    try {
      const { prisma } = run;
      const ids = ["bot-alpha", "bot-beta"] as const;
      const team = async (homeKey: string) => {
        const computer = await prisma.computer.create({
          data: {
            spaceId: run.spaceId,
            userId: run.userId,
            scope: "team",
            scopeKey: homeKey,
            homeKey,
            kind: "e2b",
            state: "stopped",
          },
        });
        return computer;
      };
      const computer = await team("live-team-home");
      for (const id of ids) {
        await prisma.bot.create({
          data: {
            id: `${id}-${live.tag.slice(-8)}`,
            spaceId: run.spaceId,
            userId: run.userId,
            name: id,
            color: "#000000",
            computerId: computer.id,
          },
        });
      }
      const botIds = ids.map((id) => `${id}-${live.tag.slice(-8)}`) as [string, string];
      const home = new LocalAgentHomeStore(path.join(dir, "homes"));
      const seed = async (homeKey: string, entries: ReturnType<typeof syntheticHome>) => {
        const src = path.join(dir, `src-${homeKey}`);
        for (const entry of entries) {
          await mkdir(path.dirname(path.join(src, entry.path)), { recursive: true });
          await writeFile(path.join(src, entry.path), entry.content, { mode: entry.mode });
        }
        return home.commit(homeKey, src, context("h"));
      };
      const revision = await seed("live-team-home", syntheticHome(botIds));
      await prisma.computer.update({
        where: { id: computer.id },
        data: { homeRevision: revision },
      });
      const lifecycle = createWorkerLifecycle({ prisma, provider: live.workerProvider() });
      const deps = { prisma, home, files, workers: lifecycle };

      const before = await live.census();
      const planned = await moveHomeToVolumes(
        deps,
        { computerId: computer.id, dryRun: true, leaveUnmapped: false, manifestPath: null },
        context("h"),
      );
      const afterDryRun = await live.census();
      const manifestPath = path.join(dir, "manifest.json");
      const moved = await moveHomeToVolumes(
        deps,
        { computerId: computer.id, dryRun: false, leaveUnmapped: false, manifestPath },
        context("h"),
      );
      if (moved.outcome !== "adopted")
        throw new Error(`The move ended ${moved.outcome}: ${JSON.stringify(moved)}`);
      const manifest = moved.manifest;
      const refOf = (destination: (typeof manifest.volumes)[number]["destination"]) =>
        manifest.volumes.find(
          (volume) => JSON.stringify(volume.destination) === JSON.stringify(destination),
        )!.providerRef!;

      const verified = [];
      for (const file of manifest.files) {
        const ref = refOf(file.destination);
        const content = await files.read(ref, file.volumePath, context("h"));
        const entry = (await files.list(ref, context("h"))).find(
          (candidate) => candidate.path === file.volumePath,
        );
        verified.push({
          path: file.homePath,
          hash: sha256(content) === file.sha256,
          mode: entry?.mode === file.mode,
        });
      }

      const sharedRef = refOf({ scope: "shared" });
      // E2B kills a volume-files sandbox at its timeout; the next call must open a new one.
      const killedSandboxes = await live.killVolumeFileSandboxes();
      const readAfterKill = new TextDecoder().decode(
        await files.read(sharedRef, "readme.md", context("h")),
      );
      const probe = (content: string, mode: number) =>
        files.write(
          sharedRef,
          { path: ".overwrite-probe", content: new TextEncoder().encode(content), mode },
          context("h"),
        );
      await probe("first", 0o644);
      await probe("second", 0o600);
      const overwritten = {
        content: new TextDecoder().decode(
          await files.read(sharedRef, ".overwrite-probe", context("h")),
        ),
        mode: (await files.list(sharedRef, context("h"))).find(
          (entry) => entry.path === ".overwrite-probe",
        )?.mode,
      };

      const mounts: Record<string, string> = {};
      for (const volume of manifest.volumes) {
        const at =
          volume.destination.scope === "shared"
            ? volumeMountPath({ kind: "space_shared" })
            : volumeMountPath({ kind: "bot_private", botId: volume.destination.botId });
        mounts[at] = volume.providerRef!;
      }
      const expected = manifest.files
        .map((file) => {
          const at =
            file.destination.scope === "shared"
              ? volumeMountPath({ kind: "space_shared" })
              : volumeMountPath({ kind: "bot_private", botId: file.destination.botId });
          return `${file.sha256}  ${at}/${file.volumePath}`;
        })
        .sort();
      const hashesIn = async (vm: Sandbox) =>
        (
          await sh(
            vm,
            `find ${Object.keys(mounts).join(" ")} -type f ! -name after-recreate.txt ! -name .overwrite-probe -exec sha256sum {} +`,
          )
        )
          .split("\n")
          .filter(Boolean)
          .sort();
      const first = await live.vm(mounts);
      const firstHashes = await hashesIn(first);
      const guestOwner = await sh(first, "id -u; id -g");
      const shared = volumeMountPath({ kind: "space_shared" });
      const migratedOwner = await sh(first, `stat -c '%u:%g' ${shared}/readme.md`);
      await sh(
        first,
        `echo probe > ${shared}/.owner-probe && chown 0:0 ${shared}/.owner-probe && chmod 600 ${shared}/.owner-probe`,
        "root",
      );
      const ownershipEnforced = await sh(
        first,
        `(cat ${shared}/.owner-probe && echo more >> ${shared}/.owner-probe) >/dev/null 2>&1 && echo no || echo yes`,
      );
      await sh(first, `rm ${shared}/.owner-probe`, "root");
      await sh(
        first,
        `echo kept > ${volumeMountPath({ kind: "space_shared" })}/after-recreate.txt`,
      );
      await first.kill();
      const second = await live.vm(mounts);
      const secondHashes = await hashesIn(second);
      const keptAcrossRecreate = await sh(
        second,
        `cat ${volumeMountPath({ kind: "space_shared" })}/after-recreate.txt`,
      );
      await second.kill();

      const again = await moveHomeToVolumes(
        deps,
        { computerId: computer.id, dryRun: true, leaveUnmapped: false, manifestPath: null },
        context("h"),
      );
      const other = await team("live-team-home-2");
      const otherRevision = await seed("live-team-home-2", [
        { path: "shared/readme.md", content: "# Another computer\n", mode: 0o644 },
      ]);
      await prisma.computer.update({
        where: { id: other.id },
        data: { homeRevision: otherRevision },
      });
      const secondComputer = await moveHomeToVolumes(
        deps,
        {
          computerId: other.id,
          dryRun: false,
          leaveUnmapped: false,
          manifestPath: path.join(dir, "manifest-2.json"),
        },
        context("h"),
      );

      const pass =
        planned.outcome === "planned" &&
        afterDryRun.volumes === before.volumes &&
        verified.length === syntheticHome(botIds).length &&
        verified.every((file) => file.hash && file.mode) &&
        JSON.stringify(firstHashes) === JSON.stringify(expected) &&
        JSON.stringify(secondHashes) === JSON.stringify(expected) &&
        keptAcrossRecreate === "kept" &&
        killedSandboxes > 0 &&
        readAfterKill === "# Team notes\n" &&
        overwritten.content === "second" &&
        overwritten.mode === 0o600 &&
        again.outcome === "already_on_volumes" &&
        secondComputer.outcome === "refused" &&
        secondComputer.refusal.code === "volume_not_empty";
      return {
        pass,
        observed: {
          dryRun: planned.outcome,
          volumesCreatedByDryRun: afterDryRun.volumes - before.volumes,
          move: moved.outcome,
          manifestFiles: manifest.files.length,
          manifestVolumes: manifest.volumes.map((volume) => volume.destination.scope),
          filesVerifiedByHashAndMode: verified.filter((file) => file.hash && file.mode).length,
          recreatedComputersSeeSameHashes: [firstHashes, secondHashes].map(
            (hashes) => JSON.stringify(hashes) === JSON.stringify(expected),
          ),
          fileWrittenBetweenRecreatesKept: keptAcrossRecreate === "kept",
          mountEnforcesOwnership: ownershipEnforced === "yes",
          volumeFileSandboxesKilled: killedSandboxes,
          readAfterSandboxKilled: readAfterKill === "# Team notes\n",
          secondMove: again.outcome,
          secondTeamComputerOfSpace:
            secondComputer.outcome === "refused"
              ? secondComputer.refusal.code
              : secondComputer.outcome,
          answersFor241: {
            volumePathFormat:
              "An E2B volume is addressed by its name. The lifecycle names it rakazo-<volume row id>, the provider records that name as the volume's provider ref, and a sandbox mounts it whole at the P1 path (/workspace/bots/<botId> or /workspace/shared). The volume content API is not served by this self-hosted deployment, so the move reaches volumes through a sandbox that mounts them.",
            writeOverwrite: `A second write of a path replaces it: it read back "${overwritten.content}" with mode ${overwritten.mode?.toString(8)}, as the last write set. The move never writes a path it did not plan, so it only rewrites its own interrupted copies.`,
            freshVolumeEmpty: "A new volume lists no entry.",
            guestUid: `The sandbox user is uid/gid ${guestOwner.replace("\n", "/")} in this template, not 1000, and the moved files belong to ${migratedOwner}. The mount ${ownershipEnforced === "no" ? "does not enforce" : "enforces"} ownership against it: that user ${ownershipEnforced === "no" ? "read and appended to" : "could not open"} a root-owned 0600 file.`,
          },
        },
      };
    } finally {
      await files.close();
      await run.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
};
