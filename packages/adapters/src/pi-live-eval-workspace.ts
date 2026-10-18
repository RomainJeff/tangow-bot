import { posix } from "node:path";
import type {
  EditOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { applyTextEdit, readLineWindow } from "./file-text.js";

export const LIVE_EVAL_LIMITS = {
  readBytes: 64 * 1024,
  writeBytes: 256 * 1024,
  files: 200,
  toolCalls: 40,
} as const;

export class LiveEvalToolError extends Error {
  override name = "LiveEvalToolError";
}

export class LiveEvalBudgetError extends LiveEvalToolError {
  override name = "LiveEvalBudgetError";
}

/**
 * File content lives in a Map rooted at an absolute path: every path must resolve inside the
 * root, and no tool reads or writes host file content. The SDK's native tools still resolve
 * paths on the host before calling these operations, so they may stat paths under the root.
 */
export class LiveEvalWorkspace {
  readonly root: string;
  private readonly files: Map<string, string>;
  private readonly signal: AbortSignal;

  constructor(options: {
    root: string;
    files: Readonly<Record<string, string>>;
    signal: AbortSignal;
  }) {
    if (!posix.isAbsolute(options.root)) throw new Error("Workspace root must be absolute");
    this.root = posix.normalize(options.root).replace(/\/+$/, "") || "/";
    this.signal = options.signal;
    this.files = new Map();
    for (const [path, content] of Object.entries(options.files)) {
      this.files.set(this.key(path), content);
    }
  }

  key(path: string): string {
    if (typeof path !== "string" || path.trim() === "" || path.includes("\0")) {
      throw new LiveEvalToolError("Path must be a non-empty workspace path");
    }
    const relative = posix.relative(this.root, posix.resolve(this.root, path));
    if (relative === "" || relative.startsWith("..") || posix.isAbsolute(relative)) {
      throw new LiveEvalToolError(`Path ${path} is outside the workspace`);
    }
    return relative;
  }

  private directory(path: string): string {
    if (path.trim() === "" || path === "." || posix.resolve(this.root, path) === this.root) {
      return "";
    }
    return this.key(path);
  }

  read(path: string): string {
    const key = this.key(path);
    const content = this.files.get(key);
    if (content === undefined) throw new LiveEvalToolError(`File ${key} does not exist`);
    if (Buffer.byteLength(content) > LIVE_EVAL_LIMITS.readBytes) {
      throw new LiveEvalToolError(
        `File ${key} exceeds the ${LIVE_EVAL_LIMITS.readBytes} byte read limit`,
      );
    }
    return content;
  }

  exists(path: string): boolean {
    return this.files.has(this.key(path));
  }

  write(path: string, content: string): void {
    this.signal.throwIfAborted();
    const key = this.key(path);
    if (Buffer.byteLength(content) > LIVE_EVAL_LIMITS.writeBytes) {
      throw new LiveEvalToolError(
        `Content exceeds the ${LIVE_EVAL_LIMITS.writeBytes} byte write limit`,
      );
    }
    if ([...this.files.keys()].some((file) => file.startsWith(`${key}/`))) {
      throw new LiveEvalToolError(`${key} is a directory`);
    }
    if (!this.files.has(key) && this.files.size >= LIVE_EVAL_LIMITS.files) {
      throw new LiveEvalToolError(`Workspace is limited to ${LIVE_EVAL_LIMITS.files} files`);
    }
    if ([...this.files.keys()].some((file) => key.startsWith(`${file}/`))) {
      throw new LiveEvalToolError(`A parent of ${key} is a file`);
    }
    this.files.set(key, content);
  }

  list(path: string): string[] {
    const dir = this.directory(path);
    const prefix = dir ? `${dir}/` : "";
    if (dir && this.files.has(dir)) throw new LiveEvalToolError(`${dir} is a file`);
    const entries = new Set<string>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const [head, ...rest] = file.slice(prefix.length).split("/");
      entries.add(rest.length ? `${head}/` : `${head}`);
    }
    if (dir && entries.size === 0) throw new LiveEvalToolError(`Directory ${dir} does not exist`);
    return [...entries].sort();
  }

  snapshot(): ReadonlyMap<string, string> {
    return new Map(this.files);
  }

  /** Read, write and edit operations for the SDK's native file tools, backed by this Map. */
  nativeOperations(): { read: ReadOperations; write: WriteOperations; edit: EditOperations } {
    const readFile = async (absolutePath: string) => Buffer.from(this.read(absolutePath));
    const access = async (absolutePath: string) => {
      if (!this.exists(absolutePath)) {
        throw new LiveEvalToolError(`File ${this.key(absolutePath)} does not exist`);
      }
    };
    const writeFile = async (absolutePath: string, content: string) =>
      this.write(absolutePath, content);
    return {
      read: { readFile, access, detectImageMimeType: async () => null },
      write: {
        writeFile,
        mkdir: async (dir: string) => {
          this.signal.throwIfAborted();
          if (posix.resolve(this.root, dir) !== this.root) this.key(dir);
        },
      },
      edit: { readFile, writeFile, access },
    };
  }
}

/** One cap and one call/error count per arm, applied at the tool wrapper of every engine. */
export class LiveEvalToolCounter {
  calls = 0;
  errors = 0;

  constructor(
    private readonly onExhausted: () => void,
    readonly limit: number = LIVE_EVAL_LIMITS.toolCalls,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.calls >= this.limit) {
      this.errors += 1;
      this.onExhausted();
      throw new LiveEvalBudgetError(`Tool budget of ${this.limit} calls is exhausted`);
    }
    this.calls += 1;
    try {
      return await work();
    } catch (error) {
      this.errors += 1;
      throw error;
    }
  }
}

const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

const positive = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/**
 * The list_files/read_file/write_file/edit_file behavior shared by the arms that keep the
 * runtime's tool names, plus list_files for the native-file arm. Returns the tool result text or
 * throws a LiveEvalToolError the engine reports to the model as a tool error.
 */
export function runWorkspaceTool(
  workspace: LiveEvalWorkspace,
  name: string,
  args: Record<string, unknown>,
): string {
  if (name === "list_files") return workspace.list(text(args.path)).join("\n");
  if (name === "read_file") {
    const window = readLineWindow(workspace.read(text(args.path)), {
      offset: positive(args.offset) ?? 1,
      limit: positive(args.limit),
      maxBytes: LIVE_EVAL_LIMITS.readBytes,
    });
    if (!window.ok) {
      throw new LiveEvalToolError(`${window.error}: the file has ${window.totalLines} lines`);
    }
    return window.nextOffset === undefined
      ? window.content
      : `${window.content}[nextOffset: ${window.nextOffset}]`;
  }
  if (name === "write_file") {
    const path = text(args.path);
    if (workspace.exists(path) && args.overwrite !== true) {
      throw new LiveEvalToolError(`File ${workspace.key(path)} exists; use edit_file or overwrite`);
    }
    const content = text(args.content);
    workspace.write(path, content);
    return `Wrote ${Buffer.byteLength(content)} bytes to ${workspace.key(path)}`;
  }
  if (name === "edit_file") {
    const path = text(args.path);
    const edit = applyTextEdit(workspace.read(path), {
      oldText: text(args.old_text),
      newText: text(args.new_text),
      replaceAll: args.replace_all === true,
    });
    if (!edit.ok) {
      throw new LiveEvalToolError(
        `${edit.error} in ${workspace.key(path)}${edit.matches ? ` (${edit.matches} matches)` : ""}`,
      );
    }
    workspace.write(path, edit.content);
    return `Edited ${workspace.key(path)} (${edit.replacements} replacements)`;
  }
  throw new LiveEvalToolError(`Unknown tool ${name}`);
}
