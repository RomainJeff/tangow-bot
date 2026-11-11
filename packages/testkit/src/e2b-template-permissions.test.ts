import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { workerTemplate } from "@tangow/agent-run-worker/template";
import { Template } from "e2b";
import { expect, it } from "vitest";
import { computerTemplate } from "../../../infra/sandboxes/computer/e2b/template.js";

it.each([
  ["worker", () => workerTemplate("pi-native", "/tmp/guest.mjs")],
  ["computer", () => computerTemplate(`registry.example.com/computer@sha256:${"a".repeat(64)}`)],
] as const)(
  "%s skills stay readable and executable after copying a restrictive checkout",
  async (_, makeTemplate) => {
    const root = mkdtempSync(path.join(tmpdir(), "e2b-skills-"));
    const skills = path.join(root, "managed-skills");
    const skill = path.join(skills, "agent", "example");
    mkdirSync(skill, { recursive: true });
    writeFileSync(path.join(skill, "SKILL.md"), "# Example", { mode: 0o600 });
    writeFileSync(path.join(skill, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(skill, 0o700);
    try {
      const dockerfile = await Template.toDockerfile(makeTemplate());
      const commands = dockerfile
        .split("\n")
        .filter((line) => line.startsWith("RUN ") && line.includes("/managed-skills"))
        .map((line) =>
          line.slice(4).replaceAll("/managed-skills", `'${skills.replaceAll("'", "'\\''")}'`),
        );
      // Ownership is enforced by the real builder; this local test exercises its filesystem modes.
      execFileSync("bash", ["-c", `chown() { return 0; }\n${commands.join("\n")}`]);
      expect(statSync(path.join(skill, "SKILL.md")).mode & 0o777).toBe(0o444);
      expect(statSync(path.join(skill, "run.sh")).mode & 0o777).toBe(0o555);
      expect(statSync(skill).mode & 0o777).toBe(0o555);
    } finally {
      execFileSync("chmod", ["-R", "u+w", root]);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
