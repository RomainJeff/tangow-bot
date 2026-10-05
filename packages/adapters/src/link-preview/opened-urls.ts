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

/** Reads a link the way a bot's message would carry it, so a percent-encoded secret still shows. */
function decodedLink(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/**
 * The salted hashes of the links a finished public web tool call showed the bot (a search hit, a
 * link in a fetched page, the final URL of a fetch): `web_search` and `web_fetch` of the bot
 * itself, with no error, read from the raw result. For `web_fetch`, `pageLinks` adds the `<a href>`
 * links of the page's HTML, which never reach the model but are as public as the page. A link that
 * redaction would change as it appears in the text, or that names a secret, is left out. Only
 * hashes leave this function, so the audit never holds a plaintext link beyond `openedUrl`.
 */
export function seenUrlHashesFromCompletion(
  completion: Pick<AgentToolCompletion, "name" | "nested" | "error" | "paused" | "result">,
  runId: string,
  secrets: string[] = [],
  pageLinks: readonly string[] = [],
): string[] {
  if (!SEEING_TOOLS.has(completion.name) || completion.nested || !succeeded(completion)) return [];
  const hashes = new Set<string>();
  const unaltered = (raw: string, url: string) =>
    redactSecrets(raw, secrets) === raw && !hasSecretParam(url);
  const add = (url: string) => {
    const hash = seenUrlHash(runId, url);
    if (hash) hashes.add(hash);
  };
  for (const url of extractSeenUrls(toolOutcome(completion.result), unaltered)) add(url);
  if (completion.name === "web_fetch" && pageLinks.length > 0) {
    const unalteredLink = (raw: string, url: string) => {
      const decoded = decodedLink(raw);
      return unaltered(raw, url) && redactSecrets(decoded, secrets) === decoded;
    };
    for (const url of extractSeenUrls([...pageLinks], unalteredLink)) add(url);
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

/** Runs of the same thread and bot whose links count: the current one and the newest others. */
export const LINK_SOURCE_RUNS = 50;
/** How far back a finished run still counts. */
export const LINK_SOURCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Tool events read for all of those runs together, the newest first. */
const LINK_SOURCE_EVENTS = 5000;

/**
 * The links the bot opened or saw in a completed run of the same thread and the same bot within
 * the last 7 days, the given run included, at most 50 runs. It selects the run ids first (the
 * `[threadId, status, createdAt]` index), then reads the `agent.tool.completed` events of those
 * run ids only, so a whole thread's events are never scanned. A failed or stopped run, another
 * thread, another bot and an older run never count. Results are keyed by run id: every hash is
 * salted with its own run.
 */
export async function readThreadLinkSources(
  prisma: Pick<PrismaClient, "event" | "run">,
  run: { id: string; threadId: string; botId: string },
  now: Date = new Date(),
): Promise<Map<string, RunLinkSources>> {
  const others = await prisma.run.findMany({
    where: {
      threadId: run.threadId,
      botId: run.botId,
      status: "completed",
      createdAt: { gte: new Date(now.getTime() - LINK_SOURCE_WINDOW_MS) },
      id: { not: run.id },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
    take: LINK_SOURCE_RUNS - 1,
  });
  const runIds = [run.id, ...others.map((other) => other.id)];
  const events = await prisma.event.findMany({
    where: { runId: { in: runIds }, type: "agent.tool.completed" },
    orderBy: { seq: "desc" },
    select: { runId: true, payload: true },
    take: LINK_SOURCE_EVENTS,
  });
  const sources = new Map<string, RunLinkSources>(
    runIds.map((id) => [id, { opened: [], seenHashes: new Set<string>() }]),
  );
  // Newest first from the database; each run is read oldest first, as it happened.
  for (const { runId, payload } of events.reverse()) {
    const source = runId ? sources.get(runId) : undefined;
    if (source && isPlainRecord(payload)) collectSources(source, payload);
  }
  return sources;
}

function collectSources(source: RunLinkSources, payload: Record<string, unknown>) {
  const url = payload.openedUrl;
  if (
    typeof url === "string" &&
    isPreviewableUrl(url) &&
    source.opened.length < OPENED_URLS_PER_RUN
  ) {
    source.opened.push(url);
  }
  const hashes = payload.seenUrlHashes;
  if (!Array.isArray(hashes)) return;
  for (const hash of hashes) {
    if (source.seenHashes.size >= SEEN_URLS_PER_RUN) break;
    if (typeof hash === "string" && SHA256_HEX.test(hash)) source.seenHashes.add(hash);
  }
}
