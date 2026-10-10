import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildImpactMap,
  fileUrlToRepoFile,
  parseImpactMap,
  specsForFile,
  touchedFiles,
  viteDocumentToRepoFile,
  viteUrlToRepoFile,
  writeImpactMap,
} from "./e2e-impact.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const webRoot = path.join(repoRoot, "apps/web");
const origin = "http://127.0.0.1:5180";

describe("touchedFiles", () => {
  it("counts a file once a function other than its module body ran", () => {
    const moduleBody = { ranges: [{ startOffset: 0, count: 1 }] };
    const scripts = [
      { url: "a", functions: [moduleBody, { ranges: [{ startOffset: 40, count: 2 }] }] },
      {
        url: "imported-only",
        functions: [moduleBody, { ranges: [{ startOffset: 40, count: 0 }] }],
      },
      { url: "outside-repo", functions: [{ ranges: [{ startOffset: 9, count: 1 }] }] },
    ];
    const toRepoFile = (url: string) => (url === "outside-repo" ? undefined : `src/${url}.ts`);
    expect(touchedFiles(scripts, toRepoFile)).toEqual(["src/a.ts"]);
  });
});

describe("viteUrlToRepoFile", () => {
  it.each([
    [`${origin}/src/main.tsx?t=1712`, "apps/web/src/main.tsx"],
    [`${origin}/e2e/fixtures/bot-page.html`, "apps/web/e2e/fixtures/bot-page.html"],
    [`${origin}/@fs${repoRoot}/packages/core/src/index.ts?v=1`, "packages/core/src/index.ts"],
    [`${origin}/@vite/client`, undefined],
    [`${origin}/node_modules/.vite/deps/react.js?v=1`, undefined],
    [`${origin}/src/missing-file.ts`, undefined],
    ["http://example.test/src/main.tsx", undefined],
  ])("maps %s", (url, file) => {
    expect(viteUrlToRepoFile(url, origin, webRoot, repoRoot)).toBe(file);
  });
});

describe("viteDocumentToRepoFile", () => {
  it.each([
    [`${origin}/app/bot-1?tab=chat`, "apps/web/index.html"],
    [`${origin}/`, "apps/web/index.html"],
    [`${origin}/e2e/fixtures/bot-page.html`, "apps/web/e2e/fixtures/bot-page.html"],
    ["about:blank", undefined],
    ["http://example.test/app", undefined],
  ])("maps the page %s", (url, file) => {
    expect(viteDocumentToRepoFile(url, origin, webRoot, repoRoot)).toBe(file);
  });
});

describe("fileUrlToRepoFile", () => {
  it("maps a repo file URL and drops node internals and dependencies", () => {
    const harness = `file://${repoRoot}/packages/testkit/src/cli/harness.ts?tsx`;
    expect(fileUrlToRepoFile(harness, repoRoot)).toBe("packages/testkit/src/cli/harness.ts");
    expect(fileUrlToRepoFile("node:internal/main", repoRoot)).toBeUndefined();
    const dependency = `file://${repoRoot}/node_modules/vitest/package.json`;
    expect(fileUrlToRepoFile(dependency, repoRoot)).toBeUndefined();
  });
});

describe("impact map", () => {
  const map = buildImpactMap(
    [
      { spec: "b.spec.ts", files: ["apps/web/src/shell.tsx", "apps/api/src/bots.ts"] },
      { spec: "a.spec.ts", files: ["apps/web/src/shell.tsx"] },
      { spec: "a.spec.ts", files: ["apps/web/src/form.tsx"] },
    ],
    "abc123",
  );

  it("is keyed by file, marks files every spec ran, and round-trips through JSON", () => {
    expect(map).toEqual({
      commit: "abc123",
      specs: ["a.spec.ts", "b.spec.ts"],
      files: {
        "apps/api/src/bots.ts": "b.spec.ts",
        "apps/web/src/form.tsx": "a.spec.ts",
        "apps/web/src/shell.tsx": "*",
      },
    });
    const parsed = parseImpactMap(JSON.stringify(map))!;
    expect(specsForFile(parsed, "apps/web/src/shell.tsx")).toEqual(["a.spec.ts", "b.spec.ts"]);
    expect(specsForFile(parsed, "apps/web/src/form.tsx")).toEqual(["a.spec.ts"]);
    expect(specsForFile(parsed, "apps/web/src/other.tsx")).toBeUndefined();
  });

  it.each([
    "",
    "{",
    '{"commit":"x","specs":[],"files":{}}',
    '{"commit":"x","specs":["a"],"files":{"f":1}}',
  ])("rejects the malformed map %s", (text) => {
    expect(parseImpactMap(text)).toBeUndefined();
  });
});

/** True when a spec takes runtime values from Playwright instead of the impact-aware `./test`. */
function importsPlaywrightDirectly(source: string) {
  return /^import\s+(?!type\s)[^;]*from\s*["']@playwright\/test["']/m.test(source);
}

describe("e2e specs", () => {
  it("import test from ./test so every spec lands in the impact map", () => {
    expect(importsPlaywrightDirectly('import { expect, test } from "@playwright/test";')).toBe(
      true,
    );
    expect(importsPlaywrightDirectly('import type { Page } from "@playwright/test";')).toBe(false);
    const specDir = path.join(webRoot, "e2e");
    const offenders = readdirSync(specDir)
      .filter((name) => name.endsWith(".spec.ts"))
      .filter((name) => importsPlaywrightDirectly(readFileSync(path.join(specDir, name), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("writeImpactMap", () => {
  it("merges per-test records into the committed map", () => {
    const root = mkdtempSync(path.join(tmpdir(), "impact-"));
    const records = path.join(root, "records");
    mkdirSync(path.join(root, "apps/web/e2e"), { recursive: true });
    mkdirSync(records);
    writeFileSync(path.join(records, "1.json"), '{"spec":"a.spec.ts","files":["x.ts"]}');
    writeFileSync(path.join(records, "2.json"), '{"spec":"b.spec.ts","files":["x.ts","y.ts"]}');
    expect(writeImpactMap(records, root, "abc")).toEqual({ specs: 2, files: 2, bytes: 132 });
    const written = readFileSync(path.join(root, "apps/web/e2e/impact-map.json"), "utf8");
    expect(JSON.parse(written)).toEqual({
      commit: "abc",
      specs: ["a.spec.ts", "b.spec.ts"],
      files: { "x.ts": "*", "y.ts": "b.spec.ts" },
    });
  });
});
