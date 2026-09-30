import { z } from "zod";

export const nativeProcessSchema = z.object({
  // Claude uses 22 entries with prompt file, resume, MCP and allowed tools;
  // reserve one additional option/value pair without relaxing argument sizes.
  argv: z.array(z.string().min(1).max(512)).min(1).max(24),
  // An empty relative path denotes the private Computer workspace root.
  cwd: z.string().max(512),
  env: z.record(z.string().max(64), z.string().max(8_192)).optional(),
  // The runtime names the per-process private home; the supervisor validates it
  // and never inspects provider-specific environment variables.
  privateHome: z.string().max(512).optional(),
  files: z
    .array(
      z.union([
        z.object({
          path: z.enum(["config.toml", "mcp-config.json"]),
          content: z.string().max(8_192),
        }),
        // A real run's instructions carry bot guidance, memory, scratchpad and
        // skills; bounded well under the 1 MiB supervisor request limit.
        z.object({
          path: z.literal("system-prompt.md"),
          content: z.string().max(256 * 1024),
        }),
      ]),
    )
    .max(2)
    .optional(),
});

export const MAX_NATIVE_PROCESS_WRITE_BYTES = 1024 * 1024;
export const nativeProcessWriteSchema = z.object({
  data: z
    .string()
    .max(MAX_NATIVE_PROCESS_WRITE_BYTES)
    .refine((data) => Buffer.byteLength(data, "utf8") <= MAX_NATIVE_PROCESS_WRITE_BYTES),
});
