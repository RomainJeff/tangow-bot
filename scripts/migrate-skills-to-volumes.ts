/** Stop the space's writers first. Copies legacy skills without deleting or replacing originals. */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { E2BVolumeFiles, e2bVolumeSandbox } from "../packages/adapters/src/e2b-volume-files.js";
import { migrateUserSkillsToShared } from "../packages/adapters/src/skill-volume-migration.js";
import { createDb } from "../packages/db/src/client.js";

const { values } = parseArgs({
  options: {
    space: { type: "string" },
    template: { type: "string", default: "rakazo-worker-pi-native" },
    "dry-run": { type: "boolean", default: false },
  },
});
if (!values.space || !process.env.DATABASE_URL)
  throw new Error("--space and DATABASE_URL are required");
const { prisma, pool } = createDb(process.env.DATABASE_URL);
const files = new E2BVolumeFiles(e2bVolumeSandbox({ template: values.template }));
try {
  const volume = await prisma.volume.findFirstOrThrow({
    where: { kind: "space_shared", spaceId: values.space, providerRef: { not: null } },
  });
  if (!volume.providerRef) throw new Error("Provision the shared volume before migrating skills");
  const operationId = randomUUID();
  const report = await migrateUserSkillsToShared(
    {
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: Operator script, never a cached Turbo task.
      source: path.join(process.env.DATA_DIR ?? "./data", "skills", "user", values.space),
      volumeRef: volume.providerRef,
      files,
      dryRun: values["dry-run"],
    },
    {
      spaceId: values.space,
      userId: "operator",
      operationId,
      traceId: operationId,
      signal: new AbortController().signal,
    },
  );
  console.log(JSON.stringify(report));
} finally {
  try {
    await files.close();
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}
