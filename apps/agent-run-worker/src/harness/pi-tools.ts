import { rm } from "node:fs/promises";
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
} from "@earendil-works/pi-coding-agent";
import type { ConnectorTool, LocalToolOutput } from "@rakazo/adapter-kit";
import { WORKER_LIMITS } from "@rakazo/adapters/runtime-worker/wire";
import type { NativeToolContext } from "../harness.js";
import { captureToolOutput } from "../tool-output.js";

/** SDK tools, with only transport capture around the SDK's local shell operations. */
function tools(
  cwd: string,
  operations = createLocalBashOperations(),
): ReturnType<typeof createCodingTools> {
  return [
    createReadTool(cwd, { autoResizeImages: false }),
    createWriteTool(cwd),
    createEditTool(cwd),
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
  return capture.finish(text, isError);
}
