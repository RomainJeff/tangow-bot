import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FILE_TOOL_NAMES,
  runFileTool,
  type WorkspaceFiles,
  workerPaths,
} from "@rakazo/adapters/file-tools";
import { WORKER_LIMITS } from "@rakazo/adapters/runtime-worker/wire";
import type { CommandOutput, LocalTool, LocalToolContext } from "./local-tools.js";

const GREP_DEFAULT_RESULTS = 100;
const GREP_MAX_RESULTS = 1000;
const GREP_LINE_CHARS = 500;
const GREP_MAX_FILE_BYTES = 10 * 1024 * 1024;
// Room for the closing note within what a guest tool shows the model.
const GREP_TEXT_CHARS = WORKER_LIMITS.localOutputModelChars - 256;
const GREP_SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

/** The bot's mounted volumes, on the guest disk. */
function guestFiles({
  botId,
  root,
}: LocalToolContext): WorkspaceFiles & { real(stored: string): string } {
  const paths = workerPaths(botId);
  const real = (stored: string) => path.join(root, paths.root, stored);
  return {
    ...paths,
    real,
    async list(directory) {
      const entries = await readdir(real(directory), { withFileTypes: true });
      const listed = await Promise.all(
        entries.map(async (entry) => {
          const stored = path.posix.join(directory, entry.name);
          const info = await stat(real(stored));
          return {
            path: stored,
            kind: info.isDirectory() ? ("dir" as const) : ("file" as const),
            size: info.isDirectory() ? 0 : info.size,
            ...(info.isFile() && info.mode & 0o100 ? { executable: true } : {}),
          };
        }),
      );
      return listed.sort((a, b) => a.path.localeCompare(b.path));
    },
    async read(file, maxBytes) {
      if ((await stat(real(file))).size > maxBytes) return null;
      return readFile(real(file));
    },
    exists: (file) =>
      lstat(real(file)).then(
        () => true,
        () => false,
      ),
    async write(file, content) {
      await mkdir(path.dirname(real(file)), { recursive: true });
      await writeFile(real(file), content);
    },
  };
}

function failed(text: string): CommandOutput {
  return { text, isError: true, truncated: false, totalBytes: 0 };
}

function fileTool(name: string): LocalTool {
  return async (args, context) => {
    try {
      return { result: await runFileTool(name, args, guestFiles(context)) };
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  };
}

function globPattern(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (glob.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 2;
    } else if (glob.startsWith("**", index)) {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** Every regular file under `stored`, in path order, without following links. */
async function filesUnder(files: ReturnType<typeof guestFiles>, stored: string): Promise<string[]> {
  if (!(await lstat(files.real(stored))).isDirectory()) return [stored];
  const found: string[] = [];
  const walk = async (directory: string) => {
    const entries: Dirent[] = await readdir(files.real(directory), { withFileTypes: true });
    for (const entry of entries) {
      const child = path.posix.join(directory, entry.name);
      if (entry.isDirectory() && !GREP_SKIPPED_DIRECTORIES.has(entry.name)) await walk(child);
      else if (entry.isFile()) found.push(child);
    }
  };
  await walk(stored);
  return found.sort();
}

/** Matching lines as `path:line:text`, in path then line order, bounded for the model. */
async function grep(
  args: Record<string, unknown>,
  context: LocalToolContext,
): Promise<CommandOutput> {
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  if (!pattern) return failed("grep needs a pattern.");
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, args.ignore_case === true ? "i" : "");
  } catch (error) {
    return failed(`invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
  const limit =
    typeof args.max_results === "number" &&
    Number.isInteger(args.max_results) &&
    args.max_results > 0
      ? Math.min(args.max_results, GREP_MAX_RESULTS)
      : GREP_DEFAULT_RESULTS;
  const requested = typeof args.path === "string" ? args.path : "";
  const glob = typeof args.glob === "string" && args.glob ? args.glob : null;
  const matcher = glob ? globPattern(glob) : null;
  const files = guestFiles(context);
  let candidates: string[];
  try {
    const stored = files.resolve(requested);
    // A glob with a slash matches the path under the searched directory, otherwise the name.
    candidates = (await filesUnder(files, stored)).filter(
      (file) =>
        !matcher ||
        matcher.test(
          glob!.includes("/") ? path.posix.relative(stored, file) : path.posix.basename(file),
        ),
    );
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }

  const lines: string[] = [];
  let chars = 0;
  let capped = false;
  scan: for (const file of candidates) {
    if (context.signal.aborted) return failed("grep aborted");
    const real = files.real(file);
    if ((await stat(real)).size > GREP_MAX_FILE_BYTES) continue;
    const bytes = await readFile(real);
    if (bytes.includes(0)) continue;
    const shown = files.display(requested, file);
    const content = bytes.toString("utf8").split("\n");
    for (let index = 0; index < content.length; index += 1) {
      const text = content[index]!;
      if (!regex.test(text)) continue;
      const line = `${shown}:${index + 1}:${text.slice(0, GREP_LINE_CHARS)}`;
      if (lines.length === limit || chars + line.length + 1 > GREP_TEXT_CHARS) {
        capped = true;
        break scan;
      }
      lines.push(line);
      chars += line.length + 1;
    }
  }
  const body = lines.length ? lines.join("\n") : "No matches.";
  const text = capped
    ? `${body}\n\n[more matches not shown: narrow the pattern, the path or the glob]`
    : body;
  return { text, isError: false, truncated: capped, totalBytes: Buffer.byteLength(text) };
}

/** The guest's file tools: the in-process file tools on the mounted volumes, and grep. */
export const FILE_TOOLS: Readonly<Record<string, LocalTool>> = {
  ...Object.fromEntries([...FILE_TOOL_NAMES].map((name) => [name, fileTool(name)])),
  grep,
};
