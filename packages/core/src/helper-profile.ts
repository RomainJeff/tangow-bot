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
  /** Overrides the call's background flag; auto or omitted leaves the choice to the bot. */
  executionMode?: "async" | "sync" | "auto";
  model?: { provider: string; id: string };
  instructions: string;
}

export const HELPER_PROFILES: readonly HelperProfile[] = [
  {
    name: "computer-use",
    description:
      "Use for anything on the computer: browsing sites, filling forms, its screen, and the commands, files or apps that exist only there. Not for what the conversation, memory, your files and shell, a web search or a page fetch already answer, and one at a time, since it holds the computer.",
    allow: ["computer_*", "browser_*", "open_path", "launch_app", "search_runs", "ask_parent"],
    exclusive: "computer",
    executionMode: "async",
    instructions: [
      "You do one task in the computer's browser for your parent bot, then report.",
      "Read pages only with the browser tools: they show what a person sees. bash runs on another machine and cannot reach the computer's pages, and curl through computer_exec skips what the page's scripts show.",
      "",
      "Tools:",
      "- browser_navigate(url) opens a page and returns only its URL and title. Read the page with browser_snapshot.",
      "- browser_snapshot returns the page text and its interactive elements with refs (e1, e2, ...), each with its role, name and value; a drop-down lists its options. A new snapshot clears the refs from older ones, so use only the refs from the latest snapshot or act result.",
      "- browser_run, when offered, does a multi-step page task on its own: give it the goal and every value to type. Start every page task with it: browser_act opens only once browser_run stops for a confirmation, a block or its step limit, or fails. If it asks for a value, call it again with that value in values.",
      "- browser_act runs up to 24 click, fill or type steps by ref, then returns the page as a fresh snapshot with its URL. Read your answer there; do not snapshot again. fill sets a text or number field, or picks a drop-down option by its label. Without browser_run, fill a whole form and click its button in one call. Clicking a link returns the page it opens.",
      '- computer_observe and computer_act see and click the screen by pixels. Use them only after a page tool answers with fallback "computer_act". Observe before clicking by coordinates.',
      "- computer_exec runs a shell command on the computer, for work that is not reading a page.",
      "",
      "Work:",
      "- Use the site's search, filters and pagination before opening pages one by one, and never open the same page twice.",
      "- Take facts from the page only, and stop as soon as the pages you read answer the brief: a fact a page states needs no second check.",
      "- After each act, check the page shows the change you expected; if not, read why once, and never repeat the same step.",
      "- If the site cannot answer the brief, or the next step needs a login, a payment or a choice the brief leaves open, stop. As a background helper, ask your parent with ask_parent; otherwise report blocked. Never invent an answer.",
      "",
      "Report, short:",
      "Status: done or blocked.",
      "Answer: each fact the brief asks for, as the page shows it, with the page's URL.",
      "Evidence: one line per candidate you ruled out and why.",
    ].join("\n"),
  },
];

/**
 * Tools the main bot hands to a helper instead of using them itself; see `delegatedTools`.
 * It keeps tools from the main bot's model. It is no security boundary: the guest names the calling `agent`.
 */
export const MAIN_BOT_BLOCKED_TOOLS: readonly string[] = [
  "computer_observe",
  "computer_act",
  "computer_exec",
  "browser_*",
  "open_path",
  "launch_app",
];

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

/** Tools any helper may use beside its work; allowing one does not make a profile startable. */
const SUPPORT_TOOLS = ["search_runs", "ask_parent"];

/** The `helpers` a bot can start: those allowing at least one of the work tools in `catalog`. */
export function startableHelpers(
  catalog: readonly { name: string }[],
  helpers: readonly HelperProfile[],
): HelperProfile[] {
  return helpers.filter((helper) =>
    catalog.some(
      (tool) =>
        !SUPPORT_TOOLS.includes(tool.name) &&
        matches(helper.allow, tool.name) &&
        !matches(helper.block, tool.name),
    ),
  );
}

/**
 * The tools of `catalog` that `blocked` names and one of `helpers` the bot can start allows.
 * The bot keeps every other tool, so it never loses work no helper can take.
 */
export function delegatedTools<T extends { name: string; where?: "guest" | "controller" }>(
  catalog: readonly T[],
  blocked: readonly string[],
  helpers: readonly HelperProfile[],
): string[] {
  const startable = startableHelpers(catalog, helpers);
  return catalog
    .filter(
      (tool) =>
        matches(blocked, tool.name) &&
        startable.some((helper) => selectTools([tool], helper).length),
    )
    .map((tool) => tool.name);
}
