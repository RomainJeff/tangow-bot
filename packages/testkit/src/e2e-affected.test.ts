import { describe, expect, it } from "vitest";
import { buildImporters, importSpecifiers, selectSpecs } from "./e2e-affected.js";
import { buildImpactMap } from "./e2e-impact.js";

const map = buildImpactMap(
  [
    { spec: "bot-crud.spec.ts", files: ["apps/web/src/app.tsx", "apps/web/src/bot-form.tsx"] },
    { spec: "spaces.spec.ts", files: ["apps/web/src/app.tsx", "apps/api/src/spaces.ts"] },
  ],
  "abc123",
);
const specsOnDisk = ["bot-crud.spec.ts", "spaces.spec.ts"];
const importers = new Map([
  ["packages/core/src/limits.ts", ["apps/api/src/spaces.ts"]],
  ["apps/web/src/util.ts", ["apps/web/src/bot-form.tsx", "apps/web/src/orphan.ts"]],
  ["apps/desktop/src/browser-auth.ts", ["apps/web/e2e/browser-auth.spec.ts"]],
]);

const select = (changed: string[], disk = specsOnDisk) =>
  selectSpecs({ changed, map, specsOnDisk: disk, importers });

describe("selectSpecs", () => {
  it("runs the specs whose recorded coverage includes a changed or deleted file", () => {
    expect(select(["apps/web/src/bot-form.tsx"])).toEqual({
      kind: "specs",
      specs: ["bot-crud.spec.ts"],
      because: { "bot-crud.spec.ts": ["apps/web/src/bot-form.tsx"] },
      ignored: [],
    });
  });

  it("walks importers up to mapped files when the changed file is not in the map", () => {
    expect(select(["packages/core/src/limits.ts", "apps/web/src/util.ts"])).toEqual({
      kind: "specs",
      specs: ["bot-crud.spec.ts", "spaces.spec.ts"],
      because: {
        "bot-crud.spec.ts": ["apps/web/src/util.ts"],
        "spaces.spec.ts": ["packages/core/src/limits.ts"],
      },
      ignored: [],
    });
  });

  it("runs a spec that imports a changed file directly, even outside the web runtime", () => {
    const selection = select(
      ["apps/desktop/src/browser-auth.ts"],
      [...specsOnDisk, "browser-auth.spec.ts"],
    );
    expect(selection).toMatchObject({
      specs: ["browser-auth.spec.ts"],
      because: {
        "browser-auth.spec.ts": ["apps/desktop/src/browser-auth.ts", "not in the impact map"],
      },
    });
  });

  it("runs a changed spec and drops a deleted one", () => {
    expect(select(["apps/web/e2e/spaces.spec.ts", "apps/web/e2e/gone.spec.ts"])).toEqual({
      kind: "specs",
      specs: ["spaces.spec.ts"],
      because: { "spaces.spec.ts": ["apps/web/e2e/spaces.spec.ts"] },
      ignored: ["apps/web/e2e/gone.spec.ts"],
    });
  });

  it("always runs a spec that is not in the map yet", () => {
    expect(select(["docs/self-host.md"], [...specsOnDisk, "new-flow.spec.ts"])).toEqual({
      kind: "specs",
      specs: ["new-flow.spec.ts"],
      because: { "new-flow.spec.ts": ["not in the impact map"] },
      ignored: ["docs/self-host.md"],
    });
  });

  it("ignores files outside the e2e runtime", () => {
    expect(select(["apps/mobile/app/index.tsx", "apps/web/src/app.test.tsx", "README.md"])).toEqual(
      {
        kind: "none",
        ignored: ["README.md", "apps/mobile/app/index.tsx", "apps/web/src/app.test.tsx"],
      },
    );
  });

  it("runs the full suite when a changed runtime file is reached by no spec", () => {
    expect(select(["apps/web/src/orphan.ts", "README.md"])).toEqual({
      kind: "full",
      reason: "no spec covers some changed runtime files",
      uncovered: ["apps/web/src/orphan.ts"],
    });
  });

  it.each([
    ["apps/web/e2e/helpers.ts", "apps/web/e2e/helpers.ts: shared e2e helpers changed"],
    ["apps/web/e2e/test.ts", "apps/web/e2e/test.ts: shared e2e helpers changed"],
    ["pnpm-lock.yaml", "pnpm-lock.yaml: dependencies changed"],
    ["apps/api/package.json", "apps/api/package.json: package manifest changed"],
    [
      "packages/db/prisma/migrations/1/migration.sql",
      "packages/db/prisma/migrations/1/migration.sql: database schema changed",
    ],
    ["apps/web/index.html", "apps/web/index.html: web build changed"],
    ["packages/testkit/src/cli/harness.ts", "packages/testkit/src/cli/harness.ts: harness changed"],
  ])("escalates to the full suite when %s changes", (file, reason) => {
    expect(select(["apps/web/src/bot-form.tsx", file])).toEqual({
      kind: "full",
      reason,
      uncovered: [],
    });
  });

  it("escalates to the full suite without a map", () => {
    expect(selectSpecs({ changed: [], map: undefined, specsOnDisk, importers })).toEqual({
      kind: "full",
      reason: "no readable impact map; run pnpm test:e2e:impact-map to record one",
      uncovered: [],
    });
  });
});

describe("importSpecifiers", () => {
  it("lists runtime imports and skips type-only ones", () => {
    const source = [
      'import { a, type B } from "./a.js";',
      'import type { C } from "./types";',
      "import {",
      "  d,",
      "  e,",
      '} from "@rakazo/core/plot";',
      'export * from "./f";',
      'export type { G } from "./g";',
      'import "./styles.css";',
      'const lazy = () => import("../locales/en/messages.po");',
      '<script type="module" src="./fixture.tsx"></script>',
    ].join("\n");
    expect(importSpecifiers(source)).toEqual([
      "./a.js",
      "@rakazo/core/plot",
      "./f",
      "./styles.css",
      "../locales/en/messages.po",
      "./fixture.tsx",
    ]);
  });
});

describe("buildImporters", () => {
  it("resolves relative, .js-for-.ts, html root, and workspace package imports", () => {
    const sources: Record<string, string> = {
      "apps/web/index.html": '<script type="module" src="/src/main.tsx"></script>',
      "apps/web/src/main.tsx": [
        'import { App } from "./app";',
        'import "./styles.css";',
        'import { Button } from "@rakazo/ui-web/components/ui/button";',
        'import { plot } from "@rakazo/core/plot";',
        'import { z } from "zod";',
      ].join("\n"),
      "apps/web/src/app.tsx": 'import { format } from "../../../packages/core/src/format.js";',
      "apps/web/src/styles.css": "",
      "packages/core/src/format.ts": "",
      "packages/core/src/plot/plot-spec.ts": "",
      "packages/ui-web/src/components/ui/button.tsx": "",
    };
    const packages = new Map([
      [
        "@rakazo/core",
        { dir: "packages/core", exports: { "./plot": { development: "./src/plot/plot-spec.ts" } } },
      ],
      [
        "@rakazo/ui-web",
        { dir: "packages/ui-web", exports: { "./components/ui/*": "./src/components/ui/*.tsx" } },
      ],
    ]);
    const importers = buildImporters(
      new Set(Object.keys(sources)),
      (file) => sources[file]!,
      packages,
    );
    expect(Object.fromEntries(importers)).toEqual({
      "apps/web/src/main.tsx": ["apps/web/index.html"],
      "apps/web/src/app.tsx": ["apps/web/src/main.tsx"],
      "apps/web/src/styles.css": ["apps/web/src/main.tsx"],
      "packages/ui-web/src/components/ui/button.tsx": ["apps/web/src/main.tsx"],
      "packages/core/src/plot/plot-spec.ts": ["apps/web/src/main.tsx"],
      "packages/core/src/format.ts": ["apps/web/src/app.tsx"],
    });
  });
});
