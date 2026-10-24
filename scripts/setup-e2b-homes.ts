// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Operator command, never a cached Turbo task.
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { DockerSandboxProvider } from "../packages/adapters/src/docker-sandbox.js";
import { prepareHomeForE2B } from "../packages/adapters/src/e2b-home-upgrade.js";
import { verifyE2BInstallation } from "../packages/adapters/src/e2b-install-check.js";
import { E2BSandboxProvider } from "../packages/adapters/src/e2b-sandbox.js";
import { LocalAgentHomeStore } from "../packages/adapters/src/home.js";
import { previewHomeVolumeMove } from "../packages/adapters/src/home-volume-migration.js";
import { createWorkerLifecycle } from "../packages/adapters/src/worker-lifecycle.js";
import { ACTIVE_RUN_STATUSES } from "../packages/core/src/run-state.js";
import { createDb } from "../packages/db/src/client.js";

const { values } = parseArgs({
  options: {
    inspect: { type: "boolean" },
    plans: { type: "boolean" },
    prepare: { type: "string" },
    verify: { type: "boolean" },
  },
});
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const { prisma, pool } = createDb(process.env.DATABASE_URL);
try {
  if (values.prepare) {
    await createWorkerLifecycle({ prisma, provider: null }).clearStaleHomeMove(values.prepare);
    const computer = await prisma.computer.findUniqueOrThrow({ where: { id: values.prepare } });
    if (computer.kind !== "docker" && computer.kind !== "e2b")
      throw new Error("Unsupported source provider");
    const source =
      computer.kind === "docker"
        ? new DockerSandboxProvider(
            process.env.SANDBOX_SUPERVISOR_URL ?? "http://supervisor:7091",
            process.env.SANDBOX_SUPERVISOR_TOKEN,
          )
        : new E2BSandboxProvider(process.env.E2B_API_KEY ?? "");
    const operationId = randomUUID();
    await prepareHomeForE2B(
      { prisma, home: new LocalAgentHomeStore(process.env.DATA_DIR ?? "/data"), source },
      computer.id,
      {
        operationId,
        traceId: operationId,
        userId: computer.userId,
        spaceId: computer.spaceId,
        signal: new AbortController().signal,
      },
    );
    await mkdir(path.join(process.env.DATA_DIR ?? "/data", "e2b-upgrade"), {
      recursive: true,
      mode: 0o700,
    });
    console.log(JSON.stringify({ prepared: computer.id }));
  } else if (values.inspect || values.verify) {
    const now = new Date();
    const [computers, runs, controls, leases, maintenance] = await Promise.all([
      prisma.computer.findMany({
        where: { homeStorage: "snapshot" },
        select: { id: true, kind: true, scope: true, spaceId: true },
        orderBy: [{ scope: "desc" }, { id: "asc" }],
      }),
      prisma.run.count({ where: { status: { in: [...ACTIVE_RUN_STATUSES] } } }),
      prisma.computer.count({ where: { controlHolder: { not: "none" } } }),
      prisma.computerExecutionLease.count({ where: { expiresAt: { gt: now } } }),
      prisma.computer.count({
        where: {
          maintenanceId: { not: null },
          OR: [{ homeMoveExpiresAt: null }, { homeMoveExpiresAt: { gt: now } }],
        },
      }),
    ]);
    const unsupported = computers.filter((c) => c.kind !== "docker" && c.kind !== "e2b").length;
    if (values.verify && computers.length)
      throw new Error(
        `${computers.length} computer homes still use snapshots; setup is incomplete`,
      );
    if (values.verify) {
      if (runs || controls || leases || maintenance || unsupported)
        throw new Error("Active work prevents worker verification");
      await verifyE2BInstallation(
        process.env.E2B_API_KEY ?? "",
        process.env.WORKER_TEMPLATE || "rakazo-worker-pi-native",
      );
    }
    const previews = [];
    if (values.plans && !runs && !controls && !leases && !maintenance && !unsupported) {
      for (const computer of computers) {
        previews.push({
          computerId: computer.id,
          ...(await previewHomeVolumeMove(
            { prisma, home: new LocalAgentHomeStore(process.env.DATA_DIR ?? "/data") },
            computer.id,
            {
              operationId: "e2b-upgrade-preview",
              traceId: "e2b-upgrade-preview",
              userId: "operator",
              spaceId: computer.spaceId,
              signal: new AbortController().signal,
            },
          )),
        });
      }
    }
    console.log(
      JSON.stringify({
        computers,
        previews,
        blockers: { runs, controls, leases, maintenance, unsupported },
      }),
    );
  } else throw new Error("Pass --inspect, --prepare <computer> or --verify");
} finally {
  await prisma.$disconnect();
  await pool.end();
}
