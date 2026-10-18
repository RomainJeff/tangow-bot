import { execFileSync } from "node:child_process";

const maxBytes = 5_000 * 4;
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const oversized = [];

// NUL delimiters preserve spaces, tabs and newlines in staged filenames.
const changes = git(
  "diff",
  "--cached",
  "--numstat",
  "--no-renames",
  "--no-ext-diff",
  "--no-textconv",
  "--diff-filter=ACMRT",
  "-z",
);
for (const change of changes.split("\0").filter(Boolean)) {
  const [, added, removed, path] = change.match(/^([^\t]+)\t([^\t]+)\t([\s\S]*)$/);
  if (added === "-" && removed === "-") continue;

  const attributes = execFileSync(
    "git",
    ["check-attr", "--cached", "-z", "--stdin", "linguist-generated", "linguist-vendored"],
    { input: `${path}\0`, encoding: "utf8" },
  ).split("\0");
  if ([attributes[2], attributes[5]].some((value) => value === "set" || value === "true")) {
    continue;
  }

  const bytes = Number(git("cat-file", "-s", `:${path}`).trim());
  if (bytes > maxBytes) oversized.push({ path, bytes });
}

if (oversized.length > 0) {
  console.error(
    "Commit blocked: staged authored files must be at most 5,000 tokens (20,000 bytes; tokens = bytes / 4).",
  );
  for (const { path, bytes } of oversized) {
    console.error(
      `  ${JSON.stringify(path)}: ${bytes.toLocaleString("en-US")} bytes, ${bytes / 4} tokens`,
    );
  }
  console.error(`
Split each file by responsibility into smaller, cohesive files:
  1. Move independent functions, types or components into named sibling modules.
     Split tests by behavior and Markdown at section boundaries into linked documents.
  2. Update imports, exports and links, and remove the extracted content from the original.
  3. Keep every resulting file at or below 20,000 bytes. Run the relevant checks.
  4. Stage the original and all new files with git add, then commit again.
For generated or vendored files, mark the exact path linguist-generated or
linguist-vendored in .gitattributes and stage that file too. Do not exempt authored code.`);
  process.exitCode = 1;
}
