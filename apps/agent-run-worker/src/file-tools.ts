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
const GREP_MAX_FILES = 20_000;
const GREP_MAX_BYTES = 256 * 1024 * 1024;
const WRITING_TOOLS = new Set(["write_file", "edit_file"]);

/** The bot's mounted volumes, on the guest disk. */
function guestFiles({
  botId,
  root,
}: LocalToolContext): WorkspaceFiles & { root: string; real(stored: string): string } {
  const paths = workerPaths(botId);
  const real = (stored: string) => path.join(root, paths.root, stored);
  return {
    ...paths,
    real,
    async list(directory) {
      const entries = await readdir(real(directory), { withFileTypes: true });
      // A link is listed as a file, and an entry gone since readdir is left out.
      const listed = await Promise.all(
        entries.map(async (entry) => {
          const stored = path.posix.join(directory, entry.name);
          const info = await lstat(real(stored)).catch(() => null);
          if (!info) return [];
          return [
            {
              path: stored,
              kind: info.isDirectory() ? ("dir" as const) : ("file" as const),
              size: info.isDirectory() ? 0 : info.size,
              ...(info.isFile() && info.mode & 0o100 ? { executable: true } : {}),
            },
          ];
        }),
      );
      return listed.flat().sort((a, b) => a.path.localeCompare(b.path));
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

/**
 * Whether a write lands on a volume that outlives the VM. Anything else under the workspace is the
 * VM's own disk, lost when it is destroyed. Reads stay permissive: they only see that same disk,
 * which bash reads anyway, and listing the workspace root shows the mounts.
 */
function writableMount(mounts: LocalToolContext["mounts"], target: string): string | null {
  const mount = mounts.find(
    (candidate) => target === candidate.path || target.startsWith(`${candidate.path}/`),
  );
  if (!mount) {
    const mounted = mounts.map((candidate) => candidate.path).join(", ") || "none";
    return `${target} is not on a mounted volume, so it would be lost when this run ends; write under a mounted volume (${mounted})`;
  }
  return mount.access === "rw" ? null : `${mount.path} is mounted read-only`;
}

function fileTool(name: string): LocalTool {
  return async (args, context) => {
    try {
      const files = guestFiles(context);
      if (WRITING_TOOLS.has(name)) {
        const target = path.posix.join(files.root, files.resolve(String(args.path ?? "")));
        const refusal = writableMount(context.mounts, target);
        if (refusal) return { result: { error: refusal, path: String(args.path ?? "") } };
      }
      const result = await runFileTool(name, args, files);
      const bytes = Buffer.byteLength(JSON.stringify(result));
      if (bytes <= WORKER_LIMITS.localResultBytes) return { result };
      return {
        result: {
          error: `the result is too large to return (${bytes} bytes); read fewer lines with offset and limit, or list a subdirectory`,
          path: String(args.path ?? ""),
        },
      };
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

/**
 * Regular files under the directory `stored`, in path order, without following links: at most
 * `GREP_MAX_FILES`, with `capped` set when there were more.
 */
async function filesUnder(
  files: ReturnType<typeof guestFiles>,
  stored: string,
  signal: AbortSignal,
): Promise<{ found: string[]; capped: boolean }> {
  const found: string[] = [];
  let capped = false;
  const walk = async (directory: string) => {
    if (signal.aborted) throw new Error("grep aborted");
    const entries: Dirent[] = await readdir(files.real(directory), { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (found.length === GREP_MAX_FILES) {
        capped = true;
        return;
      }
      const child = path.posix.join(directory, entry.name);
      if (entry.isDirectory() && !GREP_SKIPPED_DIRECTORIES.has(entry.name)) await walk(child);
      else if (entry.isFile()) found.push(child);
    }
  };
  await walk(stored);
  return { found: found.sort(), capped };
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
  let walkCapped = false;
  try {
    const stored = files.resolve(requested);
    // Like grep -r, the path named follows a link; the walk below does not.
    if ((await stat(files.real(stored))).isDirectory()) {
      const walked = await filesUnder(files, stored, context.signal);
      walkCapped = walked.capped;
      // A glob with a slash matches the path under the searched directory, otherwise the name.
      candidates = walked.found.filter(
        (file) =>
          !matcher ||
          matcher.test(
            glob!.includes("/") ? path.posix.relative(stored, file) : path.posix.basename(file),
          ),
      );
    } else {
      // A named file is searched when the glob matches its name or the path as given.
      candidates =
        !matcher || matcher.test(path.posix.basename(stored)) || matcher.test(requested)
          ? [stored]
          : [];
    }
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }

  const lines: string[] = [];
  let chars = 0;
  let capped = false;
  let bytesRead = 0;
  let readCapped = false;
  scan: for (const file of candidates) {
    if (context.signal.aborted) return failed("grep aborted");
    const real = files.real(file);
    const size = await stat(real).then(
      (info) => info.size,
      () => null,
    );
    if (size === null || size > GREP_MAX_FILE_BYTES) continue;
    if (bytesRead + size > GREP_MAX_BYTES) {
      readCapped = true;
      break;
    }
    const bytes = await readFile(real).catch(() => null);
    if (!bytes) continue;
    bytesRead += bytes.length;
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
  const note = capped
    ? "more matches not shown"
    : walkCapped || readCapped
      ? `searched only the first ${walkCapped ? `${GREP_MAX_FILES} files` : `${GREP_MAX_BYTES / 1024 / 1024} MiB`}`
      : null;
  const text = note ? `${body}\n\n[${note}: narrow the pattern, the path or the glob]` : body;
  return { text, isError: false, truncated: note !== null, totalBytes: Buffer.byteLength(text) };
}

/** The guest's file tools: the in-process file tools on the mounted volumes, and grep. */
export const FILE_TOOLS: Readonly<Record<string, LocalTool>> = {
  ...Object.fromEntries([...FILE_TOOL_NAMES].map((name) => [name, fileTool(name)])),
  grep,
};
