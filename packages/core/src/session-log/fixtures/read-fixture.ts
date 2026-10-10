import { readFileSync } from "node:fs";
import type { SessionEntry } from "@rakazo/contracts";
import { SessionEntrySchema } from "@rakazo/contracts";
import type { TailSource } from "../jsonl.js";
import { readTailFromEnd } from "../jsonl.js";

export const FIXTURES = [
  "linear",
  "rewound",
  "compacted",
  "subagent",
  "group",
  "bot-exchange",
  "steered",
] as const;
export type FixtureName = (typeof FIXTURES)[number];

export function bytesSource(bytes: Uint8Array, served = { bytes: 0 }): () => Promise<TailSource> {
  return async () => ({
    size: bytes.length,
    read: async (position, length) => {
      served.bytes += length;
      return bytes.slice(position, position + length);
    },
    close: async () => undefined,
  });
}

export function fixtureText(name: FixtureName): string {
  return readFileSync(new URL(`./${name}.jsonl`, import.meta.url), "utf8");
}

export function fixtureChain(name: FixtureName): Promise<SessionEntry[]> {
  return readTailFromEnd(bytesSource(new TextEncoder().encode(fixtureText(name))), 4096);
}

/** A linear chain from entry bodies, with ids, seqs, parents and timestamps filled in. */
export function linkEntries(prefix: string, bodies: readonly object[]): SessionEntry[] {
  return bodies.map((body, seq) =>
    SessionEntrySchema.parse({
      id: `${prefix}-${seq}`,
      sessionId: `ses_${prefix}`,
      seq,
      parentId: seq === 0 ? null : `${prefix}-${seq - 1}`,
      ts: new Date(Date.UTC(2026, 9, 10, 9, 0, seq)).toISOString(),
      ...body,
    }),
  );
}
