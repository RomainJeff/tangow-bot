import type { ComputerFileEntry } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { applyTextEdit, readLineWindow, type TextEditResult } from "./file-text.js";
import { textContentArg } from "./tool-text.js";

/** The bot's files as a file tool sees them: the computer in process, the mounted volumes in a guest. */
export interface WorkspaceFiles {
  /** The workspace path a requested path names. Throws for a path that escapes the workspace. */
  resolve(requested: string): string;
  /** How an entry's workspace path is shown back for the path the model asked for. */
  display(requested: string, stored: string): string;
  list(directory: string): Promise<ComputerFileEntry[]>;
  /** The file's bytes, or `null` when it is larger than `maxBytes`. */
  read(file: string, maxBytes: number): Promise<Uint8Array | null>;
  exists(file: string): Promise<boolean>;
  write(file: string, content: Uint8Array): Promise<void>;
}

export const FILE_TOOL_NAMES = new Set(["list_files", "read_file", "write_file", "edit_file"]);

const MAX_MODEL_FILE_BYTES = 250_000;
const READ_FILE_ERRORS = {
  offset_out_of_range: "offset is past the end of the file; use a smaller offset",
  line_too_long: "a single line is too large to return; use shell to inspect it",
};
const WRITE_FILE_EXISTS_ERROR =
  "file already exists; use edit_file to change part of it, or set overwrite to true to replace it whole";
const EDIT_FILE_ERRORS: Record<Extract<TextEditResult, { ok: false }>["error"], string> = {
  empty_old_text: "old_text is empty; pass the exact text to replace",
  not_found: "old_text not found; read the file again with read_file and copy the text exactly",
  ambiguous:
    "old_text matches several places; include more surrounding text or set replace_all to true",
};

function positiveIntegerArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Runs `list_files`, `read_file`, `write_file` or `edit_file` against a bot's files and returns the
 * result the model sees. A success of a writing tool carries `ok: true`. `redact` masks the run's
 * secrets in file text before it is paged.
 */
export async function runFileTool(
  name: string,
  args: Record<string, unknown>,
  files: WorkspaceFiles,
  redact: (text: string) => string = (text) => text,
): Promise<Record<string, unknown>> {
  if (name === "list_files") {
    const requestedPath = String(args.path ?? "");
    const entries = await files.list(files.resolve(requestedPath));
    return {
      path: requestedPath,
      entries: entries.map((entry) => ({
        ...entry,
        path: files.display(requestedPath, entry.path),
      })),
    };
  }
  if (name === "read_file") {
    const filePath = String(args.path ?? "");
    const bytes = await files.read(files.resolve(filePath), ATTACHMENT_MAX_BYTES);
    if (!bytes) return { error: "file is too large to read; use shell", path: filePath };
    const text = decodeUtf8(bytes);
    if (text === null) {
      return { error: "file is not UTF-8 text; use open_path to inspect it", path: filePath };
    }
    const window = readLineWindow(redact(text), {
      offset: positiveIntegerArg(args.offset) ?? 1,
      limit: positiveIntegerArg(args.limit),
      maxBytes: MAX_MODEL_FILE_BYTES,
    });
    if (!window.ok) {
      return {
        error: READ_FILE_ERRORS[window.error],
        path: filePath,
        totalLines: window.totalLines,
      };
    }
    const { ok: _ok, ...page } = window;
    return { path: filePath, ...page };
  }
  if (name === "write_file") {
    const filePath = String(args.path ?? "notes/result.txt");
    const content = textContentArg(args.content, "");
    const storedPath = files.resolve(filePath);
    if (args.overwrite !== true && (await files.exists(storedPath))) {
      return { error: WRITE_FILE_EXISTS_ERROR, path: filePath };
    }
    await files.write(storedPath, new TextEncoder().encode(content));
    return { ok: true, path: filePath };
  }
  if (name === "edit_file") {
    const filePath = String(args.path ?? "");
    const storedPath = files.resolve(filePath);
    const bytes = await files.read(storedPath, ATTACHMENT_MAX_BYTES);
    if (!bytes) return { error: "file is too large to edit; use shell", path: filePath };
    const current = decodeUtf8(bytes);
    if (current === null) {
      return { error: "file is not UTF-8 text; use shell to change it", path: filePath };
    }
    const edit = applyTextEdit(current, {
      oldText: textContentArg(args.old_text, ""),
      newText: textContentArg(args.new_text, ""),
      replaceAll: args.replace_all === true,
    });
    if (!edit.ok) {
      return {
        error: EDIT_FILE_ERRORS[edit.error],
        path: filePath,
        ...(edit.matches === undefined ? {} : { matches: edit.matches }),
      };
    }
    await files.write(storedPath, new TextEncoder().encode(edit.content));
    return { ok: true, path: filePath, replacements: edit.replacements };
  }
  throw new Error(`${name} is not a file tool`);
}
