import path from "node:path";
import { E2B_WORKER_GUEST_ENTRY } from "@rakazo/adapters/e2b-worker";
import type { TemplateBuilder } from "e2b";
import { Template } from "e2b";

/** The worker VM's starting profile: whole vCPUs, to be measured before it is trusted. */
export const WORKER_PROFILE = { cpuCount: 1, memoryMB: 1024 } as const;

/**
 * What every harness needs: Node for the guest bundle, bash for local tools, the workspace root.
 * Build steps run as the sandbox user unless they name root, and that user cannot write `/`.
 */
function base(bundle: string): TemplateBuilder {
  return (
    Template({ fileContextPath: path.dirname(bundle) })
      .fromNodeImage("24-bookworm")
      .setEnvs({ RAKAZO_WORKER_HOME: "/home/user" })
      .aptInstall(["bash", "ca-certificates", "git", "procps"])
      .makeDir("/workspace", { user: "root" })
      // The guest runs as the sandbox user, and a run without volumes works in /workspace itself.
      .runCmd("chown user:user /workspace", { user: "root" })
  );
}

/** What each harness adds to the base, by the name it registers in `HARNESSES`. */
// Pi accepts Debian's fdfind binary for native find.
const piLayer = (template: TemplateBuilder) => template.aptInstall(["ripgrep", "fd-find"]);

const HARNESS_LAYERS: Readonly<Record<string, (template: TemplateBuilder) => TemplateBuilder>> = {
  "pi-native": piLayer,
};

export function workerTemplate(harness: string, bundle: string): TemplateBuilder {
  const layer = HARNESS_LAYERS[harness];
  if (!layer) throw new Error(`No worker template layer for the harness "${harness}"`);
  // The bundle changes most often, so it comes last and keeps the layers above cached.
  return layer(base(bundle))
    .setEnvs({ RAKAZO_WORKER_HARNESS: harness })
    .copy("managed-skills", "/managed-skills", { user: "root" })
    .runCmd("chown -R root:root /managed-skills && chmod -R a+rX,a-w /managed-skills", {
      user: "root",
    })
    .copy(path.basename(bundle), E2B_WORKER_GUEST_ENTRY, { user: "root" });
}
