import type { WorkerProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { E2BWorkerProvider } from "./e2b-worker.js";
import type { GuestConnector } from "./runtime-worker/launcher.js";
import { createRunWorkers } from "./runtime-worker/runtime.js";
import { createWorkerLifecycle } from "./worker-lifecycle.js";

export type WorkerProviderConfig = { kind: "e2b"; apiKey: string; template: string };

/** The template `apps/agent-run-worker/template` builds for the default harness. */
const DEFAULT_WORKER_TEMPLATE = "rakazo-worker-pi";
const RECONCILE_BATCH = 10;

/**
 * `WORKER_PROVIDER` selects a worker provider, `WORKER_TEMPLATE` its guest image. E2B reads its
 * key here and its self-hosted endpoint from its own `E2B_DOMAIN` or `E2B_API_URL`. Unset means no
 * worker: every run stays in process.
 */
export function resolveWorkerProvider(
  source: NodeJS.ProcessEnv = process.env,
): WorkerProviderConfig | null {
  const kind = source.WORKER_PROVIDER?.trim();
  if (!kind) return null;
  if (kind !== "e2b") throw new Error(`Unknown WORKER_PROVIDER: ${kind}`);
  const apiKey = source.E2B_API_KEY?.trim();
  if (!apiKey) throw new Error("WORKER_PROVIDER=e2b needs E2B_API_KEY");
  return { kind, apiKey, template: source.WORKER_TEMPLATE?.trim() || DEFAULT_WORKER_TEMPLATE };
}

export function createWorkerProvider(
  config: WorkerProviderConfig | null,
): (WorkerProvider & GuestConnector) | null {
  return config
    ? new E2BWorkerProvider({ apiKey: config.apiKey, template: config.template })
    : null;
}

/**
 * Every deployment reconciles expired home moves. A provider also enables worker routing,
 * orphan worker release and volume deletion.
 */
export function composeWorkers(
  prisma: PrismaClient,
  provider: (WorkerProvider & GuestConnector) | null,
) {
  const lifecycle = createWorkerLifecycle({ prisma, provider });
  return {
    lifecycle,
    runWorkers: provider ? createRunWorkers({ prisma, lifecycle, connector: provider }) : undefined,
    async reconcileWorkers(signal: AbortSignal) {
      const context = {
        operationId: "workers.reconcile",
        traceId: "workers.reconcile",
        spaceId: "",
        userId: "",
        signal,
      };
      const counts = await lifecycle.reconcile({ limit: RECONCILE_BATCH }, context);
      if (counts.failed > 0) getLogger().error("worker reconciliation", counts);
      const swept = await lifecycle.sweepVolumes(context);
      if (swept.failed > 0) getLogger().error("volume sweep", swept);
    },
  };
}
