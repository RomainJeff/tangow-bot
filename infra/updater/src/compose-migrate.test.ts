import { readFileSync } from "node:fs";
import path from "node:path";
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
