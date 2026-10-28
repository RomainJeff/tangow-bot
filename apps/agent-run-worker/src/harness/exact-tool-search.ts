import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { createToolSearchExtension } from "@earendil-works/pi-coding-agent";
import { RAKAZO_TOOL_PREFIX } from "@rakazo/adapter-kit";

/**
 * The tools a `tool_search` result reports loading. History keeps only the result's text, not its
 * `details.loaded`, so this reads the bullet lines that `Loaded N tools` lists below.
 */
export function loadedToolNames(resultText: string): string[] {
  if (!resultText.startsWith("Loaded ")) return [];
  return resultText.split("\n").flatMap((line) => {
    const end = line.indexOf(":");
    return line.startsWith("- ") && end > 2 ? [line.slice(2, end)] : [];
  });
}

export function exactToolSearchExtension(
  resolveName: (term: string) => string = (term) => term,
): ExtensionFactory {
  return (pi) => {
    const api: ExtensionAPI = {
      ...pi,
      // Pi registers only tool_search here; erase registerTool's per-tool generics locally.
      registerTool: ((tool: ToolDefinition) => {
        pi.registerTool({
          ...tool,
          async execute(...args) {
            const input = args[1];
            if (typeof input !== "object" || input === null || !("query" in input)) {
              return tool.execute(...args);
            }
            const { query } = input;
            if (typeof query !== "string") return tool.execute(...args);
            const terms = query.split(/[\s,]+/).filter(Boolean);
            const active = pi.getActiveTools();
            const searchable = new Map<string, ToolInfo>();
            for (const candidate of pi.getAllTools()) {
              if (
                candidate.exposure === "deferred" ||
                candidate.exposure === "codemode" ||
                active.includes(candidate.name)
              ) {
                searchable.set(candidate.name, candidate);
                if (candidate.name.startsWith(RAKAZO_TOOL_PREFIX)) {
                  searchable.set(candidate.name.slice(RAKAZO_TOOL_PREFIX.length), candidate);
                }
              }
            }
            const matches = terms.map((term) => searchable.get(resolveName(term)));
            if (matches.length === 0 || !matches.every((match) => match !== undefined)) {
              return tool.execute(...args);
            }
            const loaded = [...new Set(matches)].filter((match) => !active.includes(match.name));
            const names = loaded.map((match) => match.name);
            if (names.length === 0) {
              return {
                content: [{ type: "text", text: "The requested tools are already available." }],
                details: { loaded: [] },
              };
            }
            pi.setActiveTools([...active, ...names]);
            return {
              content: [
                {
                  type: "text",
                  text: `Loaded ${loaded.length} tool${loaded.length === 1 ? "" : "s"}. They are available from your next call:\n${loaded
                    .map(
                      (match) => `- ${match.name}: ${match.description.trim().split(/\r?\n/)[0]}`,
                    )
                    .join("\n")}`,
                },
              ],
              details: { loaded: names },
            };
          },
        });
      }) as ExtensionAPI["registerTool"],
    };
    return createToolSearchExtension()(api);
  };
}
