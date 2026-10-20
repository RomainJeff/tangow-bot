import path from "node:path";
import { E2B_WORKER_GUEST_ENTRY } from "@rakazo/adapters/e2b-worker";
import { Template, type TemplateBuilder } from "e2b";

/** What every harness needs: Node for the guest bundle, bash for local tools, the workspace root. */
function base(bundle: string): TemplateBuilder {
  return Template({ fileContextPath: path.dirname(bundle) })
    .fromNodeImage("24-bookworm")
    .aptInstall(["bash", "ca-certificates", "git", "procps"])
    .makeDir("/workspace");
}

/** What each harness adds to the base, by the name it registers in `HARNESSES`. */
const HARNESS_LAYERS: Readonly<Record<string, (template: TemplateBuilder) => TemplateBuilder>> = {
  // Pi's grep tool runs ripgrep.
  pi: (template) => template.aptInstall(["ripgrep"]),
};

export function workerTemplate(harness: string, bundle: string): TemplateBuilder {
  const layer = HARNESS_LAYERS[harness];
  if (!layer) throw new Error(`No worker template layer for the harness "${harness}"`);
  // The bundle changes most often, so it comes last and keeps the layers above cached.
  return layer(base(bundle)).copy(path.basename(bundle), E2B_WORKER_GUEST_ENTRY);
}
