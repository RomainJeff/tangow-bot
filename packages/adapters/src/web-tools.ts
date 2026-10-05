import type { AdapterContext, WebFetchProvider, WebSearchProvider } from "@rakazo/adapter-kit";
import { clampMaxChars, clampMaxResults } from "./web-limits.js";

export async function webSearchFromTool(
  search: WebSearchProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  const query = String(args.query ?? "").trim();
  if (!query) return { error: "query is required" };
  try {
    const results = await search.search(
      {
        query,
        maxResults: clampMaxResults(args.maxResults),
        signal: context.signal,
      },
      context,
    );
    return { results };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * `onPageLinks` receives the links of the page's HTML, out of band: they are removed from the
 * returned value, so the tool output the model reads (and its size) is the same with or without
 * them.
 */
export async function webFetchFromTool(
  fetchProvider: WebFetchProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
  onPageLinks?: (links: string[]) => void,
) {
  const url = String(args.url ?? "").trim();
  if (!url) return { error: "url is required" };
  try {
    const result = await fetchProvider.fetch(
      {
        url,
        maxChars: clampMaxChars(args.maxChars),
        signal: context.signal,
      },
      context,
    );
    const { links, ...output } = result;
    if (links && links.length > 0) onPageLinks?.(links);
    return output;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
