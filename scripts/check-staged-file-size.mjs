import { execFileSync } from "node:child_process";

const maxBytes = 5_000 * 4;
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const oversized = [];

// NUL delimiters preserve spaces, tabs and newlines in staged filenames.
const changes = git(
  "diff",
  "--cached",
  "--numstat",
  "--find-renames",
  "--no-ext-diff",
  "--no-textconv",
  "--diff-filter=ACMRT",
  "-z",
);
const entries = changes.split("\0");
for (let index = 0; index < entries.length - 1; index++) {
  const [, added, removed, name] = entries[index].match(/^([^\t]+)\t([^\t]+)\t([\s\S]*)$/);
  const oldPath = name || entries[++index];
  const path = name || entries[++index];
  if (added === "-" && removed === "-") continue;
  if (/\.(md|markdown|mdx)$/i.test(path) || /(^|\/)(docs|plans)\//i.test(path)) continue;

  const attributes = execFileSync(
    "git",
    ["check-attr", "--cached", "-z", "--stdin", "linguist-generated", "linguist-vendored"],
    { input: `${path}\0`, encoding: "utf8" },
  ).split("\0");
  if ([attributes[2], attributes[5]].some((value) => value === "set" || value === "true")) {
    continue;
  }

  const patch = git(
    "--literal-pathspecs",
    "diff",
    "--cached",
    "--find-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-relative",
    "--unified=0",
    "--",
    oldPath,
    path,
  );
  let bytes = 0;
  let inHunk = false;
  let previousAdded = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    if (line.startsWith("@@ ")) inHunk = true;
    if (inHunk && line.startsWith("+")) {
      bytes += Buffer.byteLength(line.slice(1), "utf8") + 1;
    } else if (line.startsWith("\\ No newline at end of file") && previousAdded) {
      bytes -= 1;
    }
    previousAdded = inHunk && line.startsWith("+");
  }
  if (bytes > maxBytes) oversized.push({ path, bytes });
}

if (oversized.length > 0) {
  console.error(
    "Commit blocked: staged additions per authored file must be at most 5,000 tokens (20,000 bytes; tokens = bytes / 4).",
  );
  for (const { path, bytes } of oversized) {
    console.error(
      `  ${JSON.stringify(path)}: ${bytes.toLocaleString("en-US")} bytes, ${bytes / 4} tokens`,
    );
  }
  console.error(`
Split oversized additions by responsibility into smaller, cohesive files:
  1. Move independent functions, types or components into named sibling modules.
     Split tests by behavior.
  2. Update imports, exports and links, and remove the extracted content from the original.
  3. Keep staged additions per file at or below 20,000 bytes. Run the relevant checks.
  4. Stage the original and all new files with git add, then commit again.
Markdown, docs/ and plans/ are exempt. Removed lines do not count.
For generated or vendored files, mark the exact path linguist-generated or
linguist-vendored in .gitattributes and stage that file too. Do not exempt authored code.`);
  process.exitCode = 1;
}
