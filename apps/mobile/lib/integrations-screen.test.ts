import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("mobile integrations screen", () => {
  it("renders catalog artwork through ConnectorIcon", () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../app/integrations.tsx"),
      "utf8",
    );
    expect(src).toContain('import { ConnectorIcon } from "../components/connector-icon"');
    expect(src).toContain("<ConnectorIcon name={label} logo={item.logo} />");
  });
});
