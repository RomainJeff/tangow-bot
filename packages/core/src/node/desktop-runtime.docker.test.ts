import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, it } from "vitest";
import { browserProfilePathForScreen, shellQuote, stopBrowserCommand } from "./desktop-runtime.js";

it.skipIf(process.env.VERIFY_DOCKER_TEAM_SCREENS !== "1")(
  "stops the hinted browser through a directory alias and leaves another profile with the same basename alive",
  () => {
    const name = `rakazo-profile-identity-${randomUUID()}`;
    const docker = (...args: string[]) =>
      execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 });
    const env = {
      homeDir: "/tmp",
      workspaceDir: "/tmp/work",
      browserProfilesDir: "/tmp/work/.browser-profiles",
      displayStart: 20,
    };
    const profile = browserProfilePathForScreen("bot", env);
    const other = `/tmp/other/${path.posix.basename(profile)}`;
    const pidFile = `/tmp/tangow/browser-pid-${path.posix.basename(profile).slice("chromium-bot-".length)}`;
    try {
      docker(
        "run",
        "-d",
        "--name",
        name,
        "--network",
        "none",
        "--entrypoint",
        "sleep",
        process.env.TANGOW_COMPUTER_IMAGE ?? "tangow/computer:local",
        "infinity",
      );
      docker(
        "exec",
        name,
        "bash",
        "-eu",
        "-c",
        `mkdir -p ${shellQuote(profile)} ${shellQuote(other)} /tmp/tangow; ln -s ${shellQuote(profile)} /tmp/profile-alias`,
      );
      for (const [label, directory] of [
        ["matching", "/tmp/profile-alias"],
        ["other", other],
      ]) {
        docker(
          "exec",
          "-d",
          name,
          "node",
          "-e",
          `require('node:fs').writeFileSync('/tmp/${label}.pid', String(process.pid)); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)`,
          "--",
          `--user-data-dir=${directory}`,
        );
      }
      docker(
        "exec",
        name,
        "bash",
        "-eu",
        "-c",
        "for i in $(seq 1 100); do [ -s /tmp/matching.pid ] && [ -s /tmp/other.pid ] && exit 0; sleep 0.05; done; exit 1",
      );
      const matchingPid = docker("exec", name, "cat", "/tmp/matching.pid").trim();
      const otherPid = docker("exec", name, "cat", "/tmp/other.pid").trim();
      docker(
        "exec",
        name,
        "bash",
        "-eu",
        "-c",
        `printf %s ${shellQuote(otherPid)} >${shellQuote(pidFile)}; ln -s ${shellQuote(`fixture-${matchingPid}`)} ${shellQuote(profile)}/SingletonLock`,
      );
      docker("exec", name, "bash", "-eu", "-c", stopBrowserCommand("bot", env));
      expect(
        docker(
          "exec",
          name,
          "bash",
          "-c",
          `if [ -r /proc/${matchingPid}/cmdline ]; then cat /proc/${matchingPid}/cmdline; fi`,
        ),
      ).toBe("");
      expect(
        docker(
          "exec",
          name,
          "bash",
          "-eu",
          "-c",
          `kill -0 ${otherPid}; cat /proc/${otherPid}/cmdline`,
        ),
      ).toContain(`--user-data-dir=${other}`);
      expect(
        docker(
          "exec",
          name,
          "bash",
          "-c",
          `[ ! -e ${shellQuote(pidFile)} ] && [ ! -L ${shellQuote(profile)}/SingletonLock ] && printf clean`,
        ),
      ).toBe("clean");
    } finally {
      docker("rm", "-f", name);
    }
  },
  60_000,
);
