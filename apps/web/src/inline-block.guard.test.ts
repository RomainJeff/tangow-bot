import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The design system names a spacing token `block`, so Tailwind also reads the class
// `inline-block` as the logical size utility `inline-size: var(--space-block)` and
// stretches the element to a whole block width.
const srcDir = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(name) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx")
      ? [file]
      : [];
  });
}

describe("inline-block", () => {
  it("is never used as a class", () => {
    const offenders = sourceFiles(srcDir).filter((file) =>
      /\binline-block\b/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((file) => path.relative(srcDir, file))).toEqual([]);
  });
});
