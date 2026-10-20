import { parseArgs } from "node:util";
import { defaultBuildLogger, Template } from "e2b";
import { bundleGuest } from "../scripts/bundle.js";
import { WORKER_PROFILE, workerTemplate } from "./template.js";

const { values } = parseArgs({
  options: { harness: { type: "string", default: "pi" }, name: { type: "string" } },
});
const harness = values.harness;
const bundle = await bundleGuest();
// The SDK reads E2B_API_KEY, and E2B_DOMAIN or E2B_API_URL for a self-hosted E2B.
const built = await Template.build(
  workerTemplate(harness, bundle),
  values.name ?? `rakazo-worker-${harness}`,
  { ...WORKER_PROFILE, onBuildLogs: defaultBuildLogger() },
);
console.log(`Built the worker template ${built.name}`);
