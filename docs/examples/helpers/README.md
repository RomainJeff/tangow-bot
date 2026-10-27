# Helper examples

A bot hands work to a helper with `run_subagent`. A helper starts from its profile's instructions,
the bot's brief and the tools its profile selects. It never sees the conversation. With
`background: true` it keeps working after the bot's turn ends, and its report wakes the bot. The
person sees only the bot's replies, on web, desktop and mobile. Debug mode shows each helper's
steps inside the run that started it.

These examples are not shipped. The two profiles live in
`packages/testkit/src/helper-profiles.fixture.ts`, and the routing skill in
`parallel-research/SKILL.md`.

## The profile type

Profiles are a typed registry, `HELPER_PROFILES` in `packages/core/src/helper-profile.ts`.

```ts
interface HelperProfile {
  name: string;
  description: string;
  allow?: readonly string[];
  block?: readonly string[];
  exclusive?: "computer";
  executionMode?: "async" | "sync" | "auto";
  model?: { provider: string; id: string };
  instructions: string;
}
```

- `name` is what `run_subagent` passes as `helper`. The bot reads `name` and `description` in its
  `<available_helpers>` list, which names a profile only when it allows one of the bot's tools
  other than `search_runs` and `ask_parent`.
- A helper gets every tool its harness runs itself, plus the Rakazo tools `allow` names, minus
  what `block` names. A name ending in `*` is a prefix.
- `exclusive` holds a resource for the helper's whole run. A second helper of the same bot that
  needs it is refused until the first one ends.
- `model` replaces the bot's model for the helper, unless the call names one.
- `executionMode` forces background work with `"async"`, or waits for the result in the bot's
  current turn with `"sync"`, overriding the call's `background` flag. `"auto"` or no field lets
  the bot choose with `background` as before. The managed `computer-use` profile sets
  `executionMode: "async"` to always run computer tasks in the background. If background helpers are
  unavailable, a forced async call fails instead of switching to sync.
- `MAIN_BOT_BLOCKED_TOOLS` in the same file lists the tools the bot hands to a helper. The bot
  loses one only when it can start a helper whose profile allows it, and a helper without a
  profile keeps it. It holds the computer and browser tools, which `computer-use` takes.

The two examples:

- `researcher` reads and searches, and changes nothing. It allows `search_runs`, `web_search` and
  `web_fetch`, and blocks `bash`, `edit` and `write`.
- `screen-operator` works the computer. It allows `computer_*`, `browser_*` and `search_runs`, and
  holds `computer`.

## What the bot and its helpers can say to each other

- `helper_status` lists the bot's background helpers at work in the thread, with each brief,
  status and start time, and the question of one that waits.
- `helper_message` answers a waiting helper's question, which resumes it, or steers a working one.
- `helper_stop` stops one helper by id, or all of them with `all`. A stopped helper sends no
  report, and its worker stops at its next lease renewal, within a minute.
- `ask_parent` is offered to a background helper only. It pauses the helper on a question to the
  bot, which wakes once its current turn ends. The bot answers from what it knows or asks the
  person in its own words. It never approves an action for them: a helper's call that needs
  approval is refused, and the helper asks its parent to do it.

## Try it

1. In a dev checkout, add both profiles after `computer-use` in the registry:

   ```ts
   // packages/core/src/helper-profile.ts
   export const HELPER_PROFILES: readonly HelperProfile[] = [
     { name: "computer-use" /* ... */ },
     researcher,
     screenOperator,
   ];
   ```

   Paste the two objects from `packages/testkit/src/helper-profiles.fixture.ts` above the
   registry.
2. Start Rakazo with `pnpm dev` and open a bot that runs on a worker.
3. Send the bot the contents of `parallel-research/SKILL.md` and ask it to save it as a skill.
4. Ask for something long, such as "Compare three hotels in Alfama for June, with prices and
   reviews". The bot says it started, and its answer arrives on its own once the researcher is
   done.
5. While it works, ask "where are you at?", then "also check if breakfast is included". The bot
   answers from `helper_status` and passes the new constraint on with `helper_message`.
6. Ask it to open a website. The bot has no computer tool of its own, so it hands the task to
   `computer-use` or `screen-operator`. Ask for a second website at once: the second helper is refused while the
   first holds the computer, and the bot says so or tries again once it is free.
7. Say "stop everything". Every helper ends, and no report follows.
