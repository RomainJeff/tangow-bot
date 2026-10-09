import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Unsaved instructions are kept for the session only: nothing on the save path
// may write them to browser storage, where they would outlive a sign-out.
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "../../../../..");
const SAVE_PATH = [
  ...readdirSync(here)
    .filter((name) => /\.tsx?$/.test(name) && !name.includes(".test."))
    .map((name) => path.join(here, name)),
  path.join(repo, "apps/web/src/lib/save-store.ts"),
  path.join(repo, "packages/core/src/field-save.ts"),
  path.join(repo, "packages/ui-web/src/save-store.tsx"),
  path.join(repo, "packages/ui-web/src/text-setting-field.tsx"),
];

it("keeps drafts and saves out of browser storage", () => {
  const offenders = SAVE_PATH.filter((file) =>
    /localStorage|sessionStorage|indexedDB/.test(readFileSync(file, "utf8")),
  ).map((file) => path.relative(repo, file));
  expect(offenders).toEqual([]);
  expect(SAVE_PATH.length).toBeGreaterThan(8);
});
