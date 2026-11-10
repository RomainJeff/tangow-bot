import { SandboxKind } from "@rakazo/contracts";
import { z } from "zod";

export const BROWSER_APPROVAL_CHECKPOINT_PREFIX = '{"kind":"browser_approval_v1",';

const browserApprovalCheckpointSchema = z.object({
  kind: z.literal("browser_approval_v1"),
  effectId: z.string().min(1),
  computerId: z.string().min(1),
  computer: z.object({
    id: z.string().min(1),
    botId: z.string().min(1),
    kind: SandboxKind,
    providerRef: z.string().min(1),
    writableRoots: z.array(z.string()).optional(),
  }),
  screenLeaseId: z.string().min(1),
  /** The member whose run holds the screen, whose browser profile it shows. */
  memberId: z.string().min(1).optional(),
  lease: z
    .object({
      computerId: z.string(),
      botId: z.string(),
      runId: z.string(),
      fence: z.number().int().nonnegative(),
    })
    .nullable(),
  runFence: z.number().int().nonnegative(),
  deadline: z.number().int().positive(),
});

export type BrowserApprovalCheckpoint = z.infer<typeof browserApprovalCheckpointSchema>;

export function browserApprovalCheckpointOf(value: string | null | undefined) {
  if (!value?.startsWith(BROWSER_APPROVAL_CHECKPOINT_PREFIX)) return null;
  try {
    const parsed = browserApprovalCheckpointSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
