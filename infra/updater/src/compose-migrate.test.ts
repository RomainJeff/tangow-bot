import { readFileSync } from "node:fs";
import path from "node:path";
import { MIGRATION_WAIT_TIMEOUT_S } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Service = { command?: string[]; depends_on?: Record<string, unknown> };

const composeDir = path.resolve(import.meta.dirname, "../../compose");

describe.each([
  "docker-compose.yml",
  "docker-compose.prod.yml",
  "docker-compose.images.yml",
  "docker-compose.topology.yml",
])("%s", (file) => {
  const { services } = parse(readFileSync(path.join(composeDir, file), "utf8")) as {
    services: Record<string, Service>;
  };

  it("migrates once, before the API and the worker start", () => {
    expect(services.migrate?.command).toContain("scripts/backfill-session-log.ts");
    for (const name of ["api", "worker"]) {
      expect(services[name]?.depends_on?.migrate).toEqual({
        condition: "service_completed_successfully",
      });
    }
  });
});

// The installer runs from a download with no checkout, so it cannot read the constant itself.
it("has the installer wait for the migrate service as long as the updater does", () => {
  const installer = readFileSync(path.join(composeDir, "install-images.sh"), "utf8");
  const waits = [...installer.matchAll(/--wait-timeout (\d+)/g)].map(([, seconds]) =>
    Number(seconds),
  );
  expect(waits).toEqual([MIGRATION_WAIT_TIMEOUT_S]);
});
