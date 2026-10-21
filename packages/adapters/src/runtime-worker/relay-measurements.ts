import type { PiAiModelCall } from "@rakazo/adapter-kit";
import type { RelayConversation } from "./model-relay.js";

type Section = "system" | "tools" | "recall" | "history" | "image";
type Prompt = { attemptId?: string; bytes: Buffer; sections: { end: number; section: Section }[] };

// Only the last prompt per conversation stays in process, within a bounded cache. Never exported.
const previous = new Map<string, Prompt>();
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_CONVERSATIONS = 128;
const MAX_PROMPT_BYTES = 1024 * 1024;
let retainedBytes = 0;

/** UTF-8 bytes of a canonical transcript, not provider wire bytes or an estimated token count. */
export function measureRelayPrefix(
  conversation: RelayConversation & { attemptId: string },
  call: PiAiModelCall,
) {
  const key = JSON.stringify([
    conversation.threadId,
    conversation.botId,
    conversation.helper ?? "root",
    conversation.helper ? conversation.attemptId : undefined,
  ]);
  try {
    return measure(key, conversation.helper ? conversation.attemptId : undefined, call);
  } catch {
    const prior = previous.get(key);
    if (prior) retainedBytes -= prior.bytes.length;
    previous.delete(key);
    return null;
  }
}

export function clearRelayPrefixes(attemptId: string) {
  for (const [key, prompt] of previous) {
    if (prompt.attemptId !== attemptId) continue;
    previous.delete(key);
    retainedBytes -= prompt.bytes.length;
  }
}

function measure(key: string, attemptId: string | undefined, call: PiAiModelCall) {
  const pieces: string[] = [];
  const sections: Prompt["sections"] = [];
  let bytes = 0;
  const append = (text: string, section: Section) => {
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_PROMPT_BYTES) throw new Error("Prefix measurement exceeds its byte cap");
    pieces.push(text);
    const last = sections.at(-1);
    if (last?.section === section) last.end = bytes;
    else sections.push({ end: bytes, section });
  };
  const encode = (value: unknown, section: Section): void => {
    if (Array.isArray(value)) {
      append("[", section);
      value.forEach((item, index) => {
        if (index) append(",", section);
        encode(item, section);
      });
      append("]", section);
    } else if (value !== null && typeof value === "object") {
      const image = "type" in value && value.type === "image";
      const label = image ? "image" : section;
      append("{", label);
      Object.entries(value).forEach(([key, item], index) => {
        if (index) append(",", label);
        const field =
          section === "system" && (key === "toolsAdded" || key === "toolsRemoved")
            ? "tools"
            : key === "recall" && section === "system"
              ? "recall"
              : label;
        append(`${JSON.stringify(key)}:`, field);
        encode(item, field);
      });
      append("}", label);
    } else {
      append(JSON.stringify(value) ?? "null", section);
    }
  };
  append("[", "system");
  call.context.messages.forEach((message, index) => {
    const section =
      message.role === "system"
        ? "system"
        : message.role === "user" &&
            typeof message.content === "string" &&
            message.content.startsWith("Memory recalled") &&
            message.content.includes("<recalled_memory>")
          ? "recall"
          : "history";
    if (index) append(",", section);
    // Timing, usage and tool-result details do not reach the model's prompt.
    const fields = [
      "role",
      "content",
      "sections",
      "toolsAdded",
      "toolsRemoved",
      "toolCallId",
      "toolName",
      "isError",
    ];
    encode(
      Object.fromEntries(
        fields.filter((field) => field in message).map((field) => [field, message[field]]),
      ),
      section,
    );
  });
  append("]", "history");
  const current: Prompt = { attemptId, bytes: Buffer.from(pieces.join("")), sections };
  const prior = previous.get(key);
  let commonPrefixBytes = 0;
  if (prior) {
    const length = Math.min(prior.bytes.length, current.bytes.length);
    while (
      commonPrefixBytes < length &&
      prior.bytes[commonPrefixBytes] === current.bytes[commonPrefixBytes]
    ) {
      commonPrefixBytes += 1;
    }
    previous.delete(key);
    retainedBytes -= prior.bytes.length;
  }
  const identical =
    prior !== undefined && commonPrefixBytes === prior.bytes.length && commonPrefixBytes === bytes;
  const currentSection = current.sections.find(({ end }) => end > commonPrefixBytes)?.section;
  const priorSection = prior?.sections.find(({ end }) => end > commonPrefixBytes)?.section;
  const firstDivergingSection =
    !prior || identical
      ? null
      : currentSection === "system" || currentSection === "history"
        ? (priorSection ?? currentSection)
        : (currentSection ?? priorSection ?? "history");
  if (bytes <= MAX_BYTES) {
    previous.set(key, current);
    retainedBytes += bytes;
  }
  while (retainedBytes > MAX_BYTES || previous.size > MAX_CONVERSATIONS) {
    const oldest = previous.entries().next().value;
    if (!oldest) break;
    previous.delete(oldest[0]);
    retainedBytes -= oldest[1].bytes.length;
  }
  return {
    prefixFormat: "pi-ai-transcript-v1",
    promptBytes: bytes,
    previousRequest: prior !== undefined,
    commonPrefixBytes,
    firstDivergingSection,
  };
}
