import { randomUUID } from "node:crypto";
import { Sandbox, Volume } from "e2b";
import { shellQuote } from "./computer-support.js";
import { E2B_WORKER_GUEST_ENTRY } from "./e2b-worker.js";

/** Allocates only disposable resources; never mounts or writes an existing bot volume. */
export async function verifyE2BInstallation(apiKey: string, template: string): Promise<void> {
  const volume = await Volume.create(`rakazo-setup-check-${randomUUID()}`, {
    apiKey: apiKey,
  });
  let worker: Sandbox | undefined;
  try {
    worker = await Sandbox.create(template, {
      apiKey: apiKey,
      timeoutMs: 60000,
      metadata: { rakazo: "setup-check" },
      volumeMounts: { "/workspace/setup-probe": volume.name },
    });
    const target = `/workspace/setup-probe/.rakazo-setup-${randomUUID()}`;
    const probe = `const fs=require("node:fs"); const p=process.argv[1]; let made=false; try { fs.writeFileSync(p,"ok",{flag:"wx"}); made=true; if(fs.readFileSync(p,"utf8")!=="ok") process.exitCode=1; } finally { if(made) fs.unlinkSync(p); }`;
    const result = await worker.commands.run(
      [
        "set -eu",
        'skill="$(find /managed-skills/agent -type f -name SKILL.md -print -quit)"',
        'test -n "$skill" && test -r "$skill"',
        `test -r ${shellQuote(E2B_WORKER_GUEST_ENTRY)}`,
        `node -e ${shellQuote(probe)} ${shellQuote(target)}`,
      ].join("\n"),
      { user: "user", timeoutMs: 15000 },
    );
    if (result.exitCode !== 0)
      throw new Error("Worker VM cannot read its guest/skills or write its volume");
  } finally {
    try {
      if (worker) await worker.kill();
    } finally {
      await Volume.destroy(volume.volumeId, { apiKey: apiKey });
    }
  }
}
