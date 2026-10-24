import {
  createBashToolDefinition,
  createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";
import { WORKER_LIMITS } from "@rakazo/adapters/runtime-worker/wire";
import { captureToolOutput } from "../tool-output.js";

/** Pi owns shell execution and status; the authorized mount owns retained output. */
export function durableBashTool(
  cwd: string,
  outputRoot: string,
): ReturnType<typeof createBashToolDefinition> {
  const definition = createBashToolDefinition(cwd);
  return {
    ...definition,
    execute: async (...args: Parameters<typeof definition.execute>) => {
      const capture = await captureToolOutput(outputRoot);
      const local = createLocalBashOperations();
      let sdkBytes = 0;
      const tool = createBashToolDefinition(cwd, {
        operations: {
          exec: (command, workdir, options) =>
            local.exec(command, workdir, {
              ...options,
              onData(data) {
                capture.write(data);
                const part = data.subarray(
                  0,
                  Math.max(0, WORKER_LIMITS.localOutputSpoolBytes - sdkBytes),
                );
                sdkBytes += part.length;
                if (part.length) options.onData(part);
              },
            }),
        },
      });
      let result: Awaited<ReturnType<typeof definition.execute>>;
      try {
        // Partial SDK snapshots can advertise its ephemeral path. Publish the durable result only.
        result = await tool.execute(args[0], args[1], args[2], undefined, args[4]);
      } catch (error) {
        const output = await capture.finish(
          error instanceof Error ? error.message : String(error),
          true,
        );
        throw new Error(output.text);
      }
      const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      const output = await capture.finish(text, result.isError === true);
      const structured = result.structuredContent;
      return {
        ...result,
        content: [{ type: "text" as const, text: output.text }],
        details: output.spoolPath ? { fullOutputPath: output.spoolPath } : undefined,
        ...(typeof structured === "object" &&
          structured !== null &&
          !Array.isArray(structured) && {
            structuredContent: {
              ...structured,
              output: output.text,
              truncated: output.truncated,
              ...(output.spoolPath ? { full_output_path: output.spoolPath } : {}),
            },
          }),
      };
    },
  };
}
