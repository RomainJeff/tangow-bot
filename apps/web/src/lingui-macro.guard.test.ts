import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "@babel/core";
import { getConfig } from "@lingui/conf";
import { describe, expect, it } from "vitest";

// The other web tests mock the lingui macros, so they cannot see a `t` the macro left alone: one
// called outside the component that took it from `useLingui()` renders an empty string.
const srcDir = path.dirname(fileURLToPath(import.meta.url));
const linguiConfig = getConfig({ cwd: path.join(srcDir, "..") });

function untranslated(file: string): string[] {
  const source = readFileSync(file, "utf8");
  if (!source.includes("@lingui/")) return [];
  const result = transformSync(source, {
    filename: file,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    plugins: [["@lingui/babel-plugin-lingui-macro", { linguiConfig }]],
  });
  return (result?.code ?? "")
    .split("\n")
    .filter((line) => /\bt`/.test(line))
    .map((line) => `${path.relative(srcDir, file)}: ${line.trim()}`);
}

describe("the lingui macro", () => {
  it("compiles every tagged message in the web app", () => {
    const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .map((file) => path.join(srcDir, file));
    expect(files.flatMap(untranslated)).toEqual([]);
  });
});
