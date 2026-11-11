import type { HelperProfile } from "@tangow/core";

/**
 * Example profiles for tests and the demo in docs/examples/helpers. They never ship: a dev checkout
 * adds them to `HELPER_PROFILES` to try them.
 */
export const researcher: HelperProfile = {
  name: "researcher",
  description:
    "Researches a question on the web and in past runs, changing nothing. For long reads.",
  allow: ["search_runs", "web_search", "web_fetch"],
  block: ["bash", "edit", "write"],
  instructions:
    "Research the brief and change nothing. Cite each source you rely on. When the brief leaves a choice open that changes the answer, ask your parent with ask_parent instead of guessing. End with the answer, short.",
};

export const screenOperator: HelperProfile = {
  name: "screen-operator",
  description: "Works the bot's computer screen and browser, one task at a time.",
  allow: ["computer_*", "browser_*", "search_runs", "ask_parent"],
  exclusive: "computer",
  instructions:
    "Do the brief on the computer's screen and browser. Before any step that needs the user's approval or a login, ask your parent with ask_parent. End with what you did and what you saw.",
};
