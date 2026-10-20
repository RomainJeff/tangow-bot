import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("refuses to start without an explicit worker home even when a VM root is set", () => {
  const { RAKAZO_WORKER_HOME: _home, ...env } = process.env;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./main.ts", import.meta.url))],
    {
      env: { ...env, RAKAZO_WORKER_CAPABILITY: "unused", RAKAZO_WORKER_ROOT: env.TMPDIR },
      input: "",
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("RAKAZO_WORKER_HOME must be an explicit absolute path");
});
