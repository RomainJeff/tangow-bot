import {
  ATTACHMENT_MAX_BASE64_LENGTH,
  ATTACHMENT_MAX_BYTES,
  type AttachmentMimeType,
  isAllowedAttachmentMimeType,
  isAttachmentImageMimeType,
  LINK_BLOCK_KINDS,
  type MessageBlock,
} from "@rakazo/contracts";
import { humanizeToolName } from "./events.js";
import { isReplacedDraftOutput } from "./outbound-draft.js";

export class AttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

export function decodeAttachmentBase64(contentBase64: string): Uint8Array {
  const normalized = contentBase64.trim();
  if (!normalized) throw new AttachmentValidationError("Attachment content is empty");
  if (normalized.length > ATTACHMENT_MAX_BASE64_LENGTH) {
    throw new AttachmentValidationError("Attachment exceeds the 10 MiB limit");
  }
  if (
    normalized.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)
  ) {
    throw new AttachmentValidationError("Attachment content is not valid base64");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(normalized, "base64");
  } catch {
    throw new AttachmentValidationError("Attachment content is not valid base64");
  }
  if (bytes.byteLength === 0) throw new AttachmentValidationError("Attachment content is empty");
  if (bytes.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new AttachmentValidationError("Attachment exceeds the 10 MiB limit");
  }
  return new Uint8Array(bytes);
}

export function validateAttachmentMimeType(mimeType: string): void {
  if (!isAllowedAttachmentMimeType(mimeType)) {
    throw new AttachmentValidationError(`Unsupported attachment type: ${mimeType}`);
  }
}

export function attachmentKindForMimeType(mimeType: string): "image" | "file" {
  return isAttachmentImageMimeType(mimeType) ? "image" : "file";
}

export function messageBlockForArtifact(artifact: {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}): Extract<MessageBlock, { kind: "image" | "file" }> {
  if (attachmentKindForMimeType(artifact.mimeType) === "image") {
    return {
      kind: "image",
      artifactId: artifact.id,
      mimeType: artifact.mimeType,
      name: artifact.name,
    };
  }
  return {
    kind: "file",
    artifactId: artifact.id,
    mimeType: artifact.mimeType,
    name: artifact.name,
    size: artifact.size,
  };
}

export function promptTextForAttachments(
  text: string | undefined,
  artifacts: Array<{ name: string; mimeType: string; size: number }>,
): string {
  const caption = text?.trim() ?? "";
  const notes = artifacts
    .filter((artifact) => !isAttachmentImageMimeType(artifact.mimeType))
    .map(
      (artifact) =>
        `User attached file ${JSON.stringify(artifact.name)} (${artifact.mimeType}, ${artifact.size} bytes).`,
    );
  return [caption, ...notes].filter(Boolean).join("\n\n") || "See attached files.";
}

/** Hard caps: a tool trace reminds the next turn what it already did, it never
    replaces the tool output, so it must not be able to crowd out the history. */
const TOOL_TRACE_INPUT_MAX_CHARS = 160;
const TOOL_TRACE_OUTPUT_MAX_CHARS = 320;
const TOOL_TRACE_BLOCK_MAX_CHARS = 2000;

function abbreviateToolPayload(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Secrets are already redacted when the steps block is persisted, and the payloads were
    truncated at write time, so this only abbreviates further — it never widens.

    Plain past-tense prose on purpose: a call-shaped trace (`name(args)`) taught models to
    write fake tool calls as text instead of calling the tool. Turns that can be replayed
    as real tool calls do not go through here. */
function toolStepsToHistoryText(steps: Extract<MessageBlock, { kind: "steps" }>["steps"]): string {
  const lines: string[] = [];
  let budget = TOOL_TRACE_BLOCK_MAX_CHARS;
  let dropped = 0;
  for (const step of steps) {
    // Older blocks carry only a label and a count: degrade to the aggregate line.
    const stepLines = step.calls?.length
      ? step.calls.map((call) => {
          const input = abbreviateToolPayload(call.input, TOOL_TRACE_INPUT_MAX_CHARS);
          const whole = isReplacedDraftOutput(call.output);
          const output = whole
            ? call.output.replace(/\s+/g, " ").trim()
            : abbreviateToolPayload(call.output, TOOL_TRACE_OUTPUT_MAX_CHARS);
          const ran = `(already ran ${humanizeToolName(call.name)}, input: ${input}`;
          return { line: output ? `${ran}, result: ${output})` : `${ran})`, whole };
        })
      : [
          {
            line: `(already ran ${step.label} ${step.count === 1 ? "once" : `${step.count} times`})`,
            whole: false,
          },
        ];
    for (const { line, whole } of stepLines) {
      if (line.length > budget && !whole) {
        dropped += 1;
        continue;
      }
      budget -= line.length;
      lines.push(line);
    }
  }
  if (dropped > 0) lines.push(`(${dropped} more tool call${dropped === 1 ? "" : "s"} omitted)`);
  return lines.join("\n");
}

/**
 * Render stored blocks as the text a later turn reads.
 *
 * `botNames` maps a bot id to its display name. Callers that know the roster
 * (a group thread) pass it so a handoff reads as people rather than as two
 * opaque identifiers; everyone else keeps the ids.
 */
export function blocksToAgentHistoryText(
  blocks: MessageBlock[],
  botNames?: ReadonlyMap<string, string>,
): string {
  return blocks
    .map((block) => {
      if (block.kind === "text") return block.text;
      // Legacy reasoning blocks are not part of the answer and stay out of history.
      if (block.kind === "reasoning") return "";
      // A link's card or mention is page content nobody wrote: not history.
      if (LINK_BLOCK_KINDS.has(block.kind)) return "";
      // Without this the next turn cannot tell which tools it already ran, and repeats them.
      if (block.kind === "steps") return toolStepsToHistoryText(block.steps);
      if (block.kind === "chart") return `[chart: ${block.name}]`;
      if (block.kind === "image") return `[image: ${block.name}]`;
      if (block.kind === "file") {
        return `[file: ${block.name} (${block.mimeType}, ${block.size} bytes)]`;
      }
      if (block.kind === "handoff") {
        const from = botNames?.get(block.fromBotId) ?? block.fromBotId;
        const to = botNames?.get(block.toBotId) ?? block.toBotId;
        return `[handoff ${from} -> ${to}] ${block.text}`;
      }
      if ("text" in block && typeof block.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const EXTENSION_MIME_TYPES: Record<string, AttachmentMimeType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
};

const MIME_TYPE_EXTENSIONS: Record<AttachmentMimeType, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/json": ".json",
};

export function inferAttachmentMimeType(
  name: string,
  reportedType?: string,
): AttachmentMimeType | null {
  const dot = name.lastIndexOf(".");
  const extensionType = dot < 0 ? undefined : EXTENSION_MIME_TYPES[name.slice(dot).toLowerCase()];
  // Some browsers and native document pickers report Markdown as text/plain.
  if (extensionType === "text/markdown" && (!reportedType || reportedType === "text/plain")) {
    return extensionType;
  }
  if (reportedType && isAllowedAttachmentMimeType(reportedType)) return reportedType;
  return extensionType ?? null;
}

export function attachmentExtensionForMimeType(mimeType: string): string {
  return isAllowedAttachmentMimeType(mimeType) ? MIME_TYPE_EXTENSIONS[mimeType] : "";
}

export function attachmentsForThread<T extends { threadKey: string }>(
  attachments: readonly T[],
  threadKey: string | undefined,
): T[] {
  if (!threadKey) return [];
  return attachments.filter((attachment) => attachment.threadKey === threadKey);
}

export function attachmentsForBot<T extends { botId: string }>(
  attachments: readonly T[],
  botId: string | undefined,
): T[] {
  if (!botId) return [];
  return attachments.filter((attachment) => attachment.botId === botId);
}
