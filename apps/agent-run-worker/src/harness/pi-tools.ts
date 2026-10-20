import { constants } from "node:fs";
import { access, open, rm, writeFile } from "node:fs/promises";
import type { createCodingTools } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLocalBashOperations,
  createLsTool,
  createReadTool,
  createWriteTool,
  detectSupportedImageMimeTypeFromFile,
} from "@earendil-works/pi-coding-agent";
import type { ConnectorTool, LocalToolOutput } from "@rakazo/adapter-kit";
import { WORKER_LIMITS } from "@rakazo/adapters/runtime-worker/wire";
import type { NativeToolContext } from "../harness.js";
import { captureToolOutput } from "../tool-output.js";

const MAX_FILE_BYTES = 250 * 1024;
const READ_DESCRIPTION =
  "Read text files and images up to 250 KiB. Text output is bounded to 12000 characters and 2000 lines. Use offset/limit to page through text; follow the returned continuation offset. For larger files or a line exceeding the output limit, use bash to inspect or edit a bounded portion.";

/** Check the opened file, then bound the read too in case another process grows it. */
async function readBoundedFile(file: string): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const tooLarge = () =>
      new Error(
        "File exceeds the 250 KiB read/edit limit. Use bash to inspect or edit a bounded portion.",
      );
    if ((await handle.stat()).size > MAX_FILE_BYTES) throw tooLarge();
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES) throw tooLarge();
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/** SDK tools, with only transport capture around the SDK's local shell operations. */
function tools(
  cwd: string,
  operations = createLocalBashOperations(),
): ReturnType<typeof createCodingTools> {
  const read = createReadTool(cwd, {
    autoResizeImages: false,
    operations: {
      readFile: readBoundedFile,
      access: (file) => access(file, constants.R_OK),
      detectImageMimeType: detectSupportedImageMimeTypeFromFile,
    },
  });
  read.description = READ_DESCRIPTION;
  return [
    read,
    createWriteTool(cwd),
    createEditTool(cwd, {
      operations: {
        readFile: readBoundedFile,
        writeFile: (file, content) => writeFile(file, content),
        access: (file) => access(file, constants.R_OK | constants.W_OK),
      },
    }),
    createBashTool(cwd, { operations, exposeSessionEnvironment: false }),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ];
}

/** Used to generate the SDK-free manifest shared with the controller. */
export function piToolManifest(): ConnectorTool[] {
  return tools("/workspace").map(({ name, description, parameters }) => ({
    name,
    description,
    inputSchema: JSON.parse(JSON.stringify(parameters)),
    readOnly: !["write", "edit", "bash"].includes(name),
  }));
}

export async function executePiTool(
  name: string,
  args: Record<string, unknown>,
  callId: string,
  { cwd, signal, spoolDir }: NativeToolContext,
): Promise<LocalToolOutput> {
  const capture = await captureToolOutput(spoolDir);
  let sdkBytes = 0;
  const local = createLocalBashOperations();
  const native = tools(cwd, {
    exec: (command, workdir, options) =>
      local.exec(command, workdir, {
        ...options,
        onData(data) {
          capture.write(data);
          // Pi also spools internally. Bound that temporary copy; P2 retains the raw stream.
          const part = data.subarray(
            0,
            Math.max(0, WORKER_LIMITS.localOutputSpoolBytes - sdkBytes),
          );
          sdkBytes += part.length;
          if (part.length) options.onData(part);
        },
      }),
  }).find((tool) => tool.name === name);
  let text: string;
  let isError = false;
  try {
    if (!native) throw new Error(`Unknown native tool ${name}`);
    const result = await native.execute(callId, args, signal);
    text = result.content
      .map((part) => (part.type === "text" ? part.text : JSON.stringify(part)))
      .join("\n");
    isError = result.isError === true;
    if (result.content.some((part) => part.type === "image")) {
      const rich = { kind: "agent_tool_result", content: result.content, details: {} };
      if (
        Buffer.byteLength(JSON.stringify({ result: rich })) <= WORKER_LIMITS.controllerResultBytes
      ) {
        await capture.finish("", false);
        return { result: JSON.parse(JSON.stringify(rich)) };
      }
    }
    if (
      result.details &&
      typeof result.details === "object" &&
      "fullOutputPath" in result.details &&
      typeof result.details.fullOutputPath === "string"
    ) {
      await rm(result.details.fullOutputPath, { force: true });
    }
  } catch (error) {
    text = error instanceof Error ? error.message : String(error);
    isError = true;
  }
  // Keep raw bash output on the mounted volume, even though Pi also truncates its own result.
  // The SDK's structuredContent and image payloads never enter an unbounded P2 frame.
  return capture.finish(
    text,
    isError,
    name === "read" && !isError ? Number(args.offset ?? 1) : undefined,
  );
}
