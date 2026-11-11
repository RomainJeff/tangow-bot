// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Operator command, never a cached Turbo task.
/**
 * Carries one stopped Docker computer whose home is on Docker volumes to E2B: copies each of its
 * volumes from DATA_DIR/volumes into an E2B volume, verifies every file by hash and mode, then
 * switches the volume and the computer to E2B. The local directories stay as they are. Running it
 * again after success changes nothing; after an interruption it resumes.
 *
 *   pnpm exec tsx scripts/carry-docker-volumes-to-e2b.ts --computer <id> [--template <template>]
 *
 * `scripts/setup-e2b-homes.ts --inspect --plans` previews what it copies and leaves behind.
 *
 * Reads DATABASE_URL, DATA_DIR, and E2B's own environment: E2B_API_KEY, and E2B_DOMAIN or
 * E2B_API_URL for a self-hosted E2B.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { DockerWorkerProvider } from "../packages/adapters/src/docker-worker.js";
import { carryDockerVolumesToE2B } from "../packages/adapters/src/e2b-home-upgrade.js";
import { E2BVolumeFiles, e2bVolumeSandbox } from "../packages/adapters/src/e2b-volume-files.js";
import { E2BWorkerProvider } from "../packages/adapters/src/e2b-worker.js";
import { createDb } from "../packages/db/src/client.js";

const { values } = parseArgs({
  options: {
    computer: { type: "string" },
    template: { type: "string", default: "tangow-worker-pi-native" },
  },
});

async function main() {
  if (!values.computer) throw new Error("--computer is required");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) throw new Error("E2B_API_KEY is not set");
  const dataDir = process.env.DATA_DIR ?? "/data";
  const { prisma, pool } = createDb(url);
  const files = new E2BVolumeFiles(e2bVolumeSandbox({ template: values.template }));
  try {
    const operationId = randomUUID();
    const report = await carryDockerVolumesToE2B(
      {
        prisma,
        dataDir,
        // Only its volume paths under DATA_DIR are used: the supervisor is never called.
        source: new DockerWorkerProvider({
          supervisorUrl: "http://127.0.0.1:9",
          supervisorToken: "unused",
          dataDir,
        }),
        // The SDK reads E2B_DOMAIN or E2B_API_URL itself.
        target: new E2BWorkerProvider({ apiKey, template: values.template }),
        files,
      },
      values.computer,
      {
        operationId,
        traceId: operationId,
        spaceId: "operator",
        userId: "operator",
        signal: new AbortController().signal,
      },
    );
    console.log(JSON.stringify(report, null, 2));
    if (report.outcome === "refused") process.exitCode = 1;
    if (report.outcome === "refused" && report.refusal.code === "home_move_incomplete") {
      console.error(
        "Its home is still moving onto its Docker volumes: run scripts/migrate-docker-homes.ts first.",
      );
    }
  } finally {
    // A sandbox left behind dies at its timeout: say so, without replacing the report.
    await files.close().catch((error: unknown) => {
      console.error(
        `Some volume sandboxes were not destroyed and stop at their one-hour timeout: ${error instanceof Error ? error.message : error}`,
      );
      process.exitCode = 1;
    });
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
