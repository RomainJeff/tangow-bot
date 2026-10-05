import { createHash } from "node:crypto";
import type { AgentToolCompletion } from "@rakazo/adapter-kit";
import { isPreviewableUrl, LINK_PREVIEW_URL_MAX_LENGTH } from "@rakazo/contracts";
import { extractSeenUrls, hasSecretParam, normalizePreviewUrl, redactSecrets } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/** At most this many opened URLs count for one run. */
export const OPENED_URLS_PER_RUN = 50;
/** At most this many distinct seen-URL hashes count for one run. */
export const SEEN_URLS_PER_RUN = 300;
const OPENING_TOOLS: ReadonlySet<string> = new Set(["web_fetch", "browser_navigate"]);
/**
 * The tools whose results may show a link: keyless, cookie-less reads of the public web, so a link
 * in them was there before the bot cited it. The logged-in browser is never a source: a snapshot
 * returns what the page holds and what the bot typed into it (field values, an authenticated
 * page's links), and `browser_navigate` only ever counts as the URL it was asked to open.
 */
const SEEING_TOOLS: ReadonlySet<string> = new Set(["web_search", "web_fetch"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The raw value a tool returned: the runtime wraps it in `details`. */
function toolOutcome(result: unknown): unknown {
  if (isPlainRecord(result) && "details" in result && Array.isArray(result.content)) {
    return result.details;
  }
  return result;
}

function succeeded(completion: Pick<AgentToolCompletion, "error" | "paused" | "result">) {
  if (completion.error !== undefined || completion.paused) return false;
  const outcome = toolOutcome(completion.result);
  if (!isPlainRecord(outcome)) return false;
  return !outcome.error && !outcome.fallback && outcome.ok !== false && !outcome.uncertain;
}

/**
 * The URL the bot asked to open, when the call really opened it: a finished `web_fetch` or
 * `browser_navigate` of the bot itself (not a subagent's) with no error. It is `args.url` and
 * nothing else: not the final URL after a redirect, not a search hit, not a link read in a page.
 */
export function openedUrlFromCompletion(
  completion: Pick<AgentToolCompletion, "name" | "args" | "nested" | "error" | "paused" | "result">,
): string | undefined {
  if (!OPENING_TOOLS.has(completion.name) || completion.nested) return undefined;
  const requested = completion.args?.url;
  if (typeof requested !== "string") return undefined;
  const url = requested.trim();
  if (url.length > LINK_PREVIEW_URL_MAX_LENGTH || !isPreviewableUrl(url)) return undefined;
  return succeeded(completion) ? url : undefined;
}

/**
 * SHA-256 (hex) of a run's id and a URL in its normalized form: what a seen link is stored and
 * matched as. The run id salts it, so a hash proves nothing outside its own run and the same link
 * never has the same hash twice.
 */
export function seenUrlHash(runId: string, url: string): string | undefined {
  const normalized = normalizePreviewUrl(url);
  return normalized
    ? createHash("sha256").update(`${runId}\n${normalized}`).digest("hex")
    : undefined;
}

/**
 * The salted hashes of the links a finished public web tool call showed the bot (a search hit, a
 * link in a fetched page, the final URL of a fetch): `web_search` and `web_fetch` of the bot
 * itself, with no error, read from the raw result. A link that redaction would change as it
 * appears in the text, or that names a secret, is left out. Only hashes leave this function, so
 * the audit never holds a plaintext link beyond `openedUrl`.
 */
export function seenUrlHashesFromCompletion(
  completion: Pick<AgentToolCompletion, "name" | "nested" | "error" | "paused" | "result">,
  runId: string,
  secrets: string[] = [],
): string[] {
  if (!SEEING_TOOLS.has(completion.name) || completion.nested || !succeeded(completion)) return [];
  const hashes = new Set<string>();
  const unaltered = (raw: string, url: string) =>
    redactSecrets(raw, secrets) === raw && !hasSecretParam(url);
  for (const url of extractSeenUrls(toolOutcome(completion.result), unaltered)) {
    const hash = seenUrlHash(runId, url);
    if (hash) hashes.add(hash);
  }
  return [...hashes];
}

/** What a run's own `agent.tool.completed` events say it opened and saw. */
export interface RunLinkSources {
  /** The URLs the bot opened, in order. */
  opened: string[];
  /** SHA-256 hashes of the normalized links its public web tools showed it. */
  seenHashes: Set<string>;
}

export async function readRunLinkSources(
  prisma: Pick<PrismaClient, "event">,
  runId: string,
): Promise<RunLinkSources> {
  const events = await prisma.event.findMany({
    where: { runId, type: "agent.tool.completed" },
    orderBy: { seq: "asc" },
    select: { payload: true },
    take: 2000,
  });
  const opened: string[] = [];
  const seenHashes = new Set<string>();
  for (const { payload } of events) {
    if (!isPlainRecord(payload)) continue;
    const url = payload.openedUrl;
    if (typeof url === "string" && isPreviewableUrl(url) && opened.length < OPENED_URLS_PER_RUN) {
      opened.push(url);
    }
    const hashes = payload.seenUrlHashes;
    if (!Array.isArray(hashes)) continue;
    for (const hash of hashes) {
      if (seenHashes.size >= SEEN_URLS_PER_RUN) break;
      if (typeof hash === "string" && SHA256_HEX.test(hash)) seenHashes.add(hash);
    }
  }
  return { opened, seenHashes };
}
