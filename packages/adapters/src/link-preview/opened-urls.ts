import type { AgentToolCompletion } from "@rakazo/adapter-kit";
import { isPreviewableUrl, LINK_PREVIEW_URL_MAX_LENGTH } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

/** At most this many opened URLs count for one run. */
export const OPENED_URLS_PER_RUN = 50;
const OPENING_TOOLS: ReadonlySet<string> = new Set(["web_fetch", "browser_navigate"]);

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

/** The URLs a run opened, in order, from its own `agent.tool.completed` events only. */
export async function readOpenedUrls(
  prisma: Pick<PrismaClient, "event">,
  runId: string,
): Promise<string[]> {
  const events = await prisma.event.findMany({
    where: { runId, type: "agent.tool.completed" },
    orderBy: { seq: "asc" },
    select: { payload: true },
    take: 2000,
  });
  const urls: string[] = [];
  for (const { payload } of events) {
    const url = isPlainRecord(payload) ? payload.openedUrl : undefined;
    if (typeof url === "string" && isPreviewableUrl(url)) urls.push(url);
    if (urls.length >= OPENED_URLS_PER_RUN) break;
  }
  return urls;
}
