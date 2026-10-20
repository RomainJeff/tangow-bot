/**
 * Moves one stopped computer's home from AgentHomeStore snapshots onto its E2B volumes, verifies
 * every file by hash, then adopts the volumes. It refuses rather than write over anything, and
 * the AgentHomeStore copy stays as the original. Running it again after success changes nothing;
 * after an interruption it resumes the copy.
 *
 *   pnpm exec tsx scripts/migrate-home-to-volumes.ts --computer <id> --manifest <path>
 *     [--dry-run] [--leave-unmapped] [--uid <n> --gid <n>]
 *
 * Reads DATABASE_URL, DATA_DIR for the AgentHomeStore, and E2B's own environment: E2B_API_KEY,
 * and E2B_DOMAIN or E2B_API_URL for a self-hosted E2B.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { E2B_GUEST_OWNER, E2BVolumeFiles } from "../packages/adapters/src/e2b-volume-files.js";
import { E2BWorkerProvider } from "../packages/adapters/src/e2b-worker.js";
import { LocalAgentHomeStore } from "../packages/adapters/src/home.js";
import { moveHomeToVolumes } from "../packages/adapters/src/home-volume-migration.js";
import { createWorkerLifecycle } from "../packages/adapters/src/worker-lifecycle.js";
import { createDb } from "../packages/db/src/client.js";

function options() {
  const { values } = parseArgs({
    options: {
      computer: { type: "string" },
      manifest: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "leave-unmapped": { type: "boolean", default: false },
      uid: { type: "string", default: String(E2B_GUEST_OWNER.uid) },
      gid: { type: "string", default: String(E2B_GUEST_OWNER.gid) },
    },
  });
  const dryRun = values["dry-run"];
  if (!values.computer) throw new Error("--computer is required");
  if (!values.manifest && !dryRun) throw new Error("--manifest is required");
  const [uid, gid] = [Number(values.uid), Number(values.gid)];
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error("--uid and --gid are ids");
  return {
    computerId: values.computer,
    manifest: values.manifest,
    dryRun,
    leaveUnmapped: values["leave-unmapped"],
    owner: { uid, gid },
  };
}

async function main() {
  const input = options();
  if (!process.env.DATABASE_URL && existsSync(".env")) process.loadEnvFile(".env");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) throw new Error("E2B_API_KEY is not set");
  const { prisma, pool } = createDb(url);
  try {
    // The SDK reads E2B_DOMAIN or E2B_API_URL itself. Volumes do not depend on the template.
    const provider = new E2BWorkerProvider({ apiKey, template: "rakazo-worker-pi" });
    const operationId = randomUUID();
    const report = await moveHomeToVolumes(
      {
        prisma,
        home: new LocalAgentHomeStore(process.env.DATA_DIR ?? "./data"),
        files: new E2BVolumeFiles({ owner: input.owner }),
        workers: createWorkerLifecycle({ prisma, provider }),
      },
      input,
      {
        operationId,
        traceId: operationId,
        spaceId: "operator",
        userId: "operator",
        signal: new AbortController().signal,
      },
    );
    if (report.outcome !== "planned" && "manifest" in report && report.manifest && input.manifest) {
      await writeFile(input.manifest, `${JSON.stringify(report.manifest, null, 2)}\n`);
    }
    console.log(JSON.stringify(report, null, 2));
    if (report.outcome === "refused") process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
