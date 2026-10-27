/** A resource one helper of a bot holds at a time. */
export type HelperResource = "computer";

/** A managed helper a bot delegates to by name with `run_subagent`. */
export interface HelperProfile {
  name: string;
  description: string;
  /** Tools granted beyond the harness's own: exact names, or prefixes ending in `*`. */
  allow?: readonly string[];
  /** Tools removed after `allow`, the harness's own included. */
  block?: readonly string[];
  exclusive?: HelperResource;
  model?: { provider: string; id: string };
  instructions: string;
}

export const HELPER_PROFILES: readonly HelperProfile[] = [];

/** Tools the main bot is never offered. A helper's profile can still allow them. */
export const MAIN_BOT_BLOCKED_TOOLS: readonly string[] = [];

const matches = (patterns: readonly string[] | undefined, name: string) =>
  patterns?.some((pattern) =>
    pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
  ) ?? false;

/** The harness's own tools (`where: "guest"`) and each tool `allow` names, minus each `block` names. */
export function selectTools<T extends { name: string; where?: "guest" | "controller" }>(
  catalog: readonly T[],
  { allow, block }: Pick<HelperProfile, "allow" | "block">,
): T[] {
  return catalog.filter(
    (tool) => (tool.where === "guest" || matches(allow, tool.name)) && !matches(block, tool.name),
  );
}
