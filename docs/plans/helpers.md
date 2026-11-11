# Specialized helpers plan

Issue #386. A bot delegates a task to a helper chosen by a versioned profile, and a background helper keeps working after the bot's turn ends and wakes the bot with a short report. The person using Tangow sees only the bot's replies. Helpers are invisible on web, desktop and mobile, and the cards `run_subagent` draws today go away. The rule the program enforces is that the controller owns the trust boundary (profiles, tool selection, exclusive locks, helper state, the report and the wake), and the harness only runs the loop. Scope is the mechanism plus example profiles, then one real managed profile, `computer-use`, measured on a browser task (H6). The other real profiles (`general`, `coding`, `video`), the real routing skills, the `delegate-to-opencode` migration and the removal of computer and browser tools from the main bot come next. PRs in order are H1 (remove helper cards), H2 (managed profiles on sync `run_subagent`), H3 (exclusive lock), H4 (background lifecycle and wake), H5 (helper status, message, stop and `ask_parent`, examples and CHANGELOG) and H6 (a managed `computer-use` profile and a browser benchmark with and without it).

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `.claude/skills/poteto-mode/playbooks/autopilot-full.md` on the slice PRs, adapted to the feature-branch rule in `AGENTS.md`. Every slice PR targets `feature/helpers`, and its owner merges it there after a clean verdict. H1, H4 and H6 are review-gated and stop at merge-ready for the operator. The feature PR `feature/helpers` to `main` is the operator's item. It stays draft until H6 merges, then the operator marks it ready and lands it after bot review.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

### Decisions this plan carries

These come from issue #386 and its two decision comments. They are settled and every owner treats them as fixed.

- Context. A helper is not a fork of the parent. It starts from its profile instructions, the parent's brief and its selected tools. Files and images travel by volume path. `search_runs` stays available. There is no `context: "fork"` option.
- Tools. A profiled helper gets every native harness tool by default, plus an `allow` list, minus a `block` list. The main bot goes through the same selection with `MAIN_BOT_BLOCKED_TOOLS`, empty in this program. The next phase puts `computer_*` and `browser_*` there, so computer and browser tools leave the main bot (H2).
- Visibility. Helpers are invisible in the conversation on every surface. No helper cards. Traces stay in debug mode and in Langfuse.
- Questions. A background helper that is blocked or unsure asks its parent with `ask_parent` instead of assuming, and waits paused until the parent answers with `helper_message`. The parent decides what to do, including asking the user in its own voice. The parent never approves an action on the user's behalf.
- Planning. Tangow adds no todo list. Each harness plans with what it already knows (scratchpad, todo tools). `helper_status` only reports which helpers are running.
- Depth. Delegation depth is 1. A helper never gets `run_subagent` or the `helper_*` tools (`isHelperTool`).
- Sources. Profiles are managed only for now, as a typed TypeScript registry `HELPER_PROFILES` in `packages/core`. Bot and shared sources come later, in files.
- Debug. Helper cards leave the conversation, but debug mode still shows each helper's detail inside a run.
- Runtime. A sync helper stays in the parent's guest (`subagent.start`). Only a background helper gets its own worker attempt.
- No fallback and no kill switch. Defects get fixed forward.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show origin/main:.claude/skills/poteto-mode/playbooks/autopilot-full.md`
  - [ ] `git show origin/main:.claude/skills/swarm/SKILL.md`
  - [ ] `git show origin/main:AGENTS.md`
  - [ ] `git show origin/main:.claude/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `git show origin/main:.claude/skills/principle-laziness-protocol/SKILL.md`
  - [ ] `git show origin/main:.claude/skills/principle-subtract-before-you-add/SKILL.md`
  - [ ] `git show origin/main:skills/README.md`
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] With the first slice commit, open the draft feature PR `feature/helpers` to `main` with a `## Sub-PRs` task list, and update it whenever a slice opens, merges or drops.
- [ ] Follow this dependency graph. Every slice branches from `feature/helpers` after its parent merges there.
  - [ ] H1 and H2 are independent and first.
  - [ ] H3 after H2.
  - [ ] H4 after H1 and H3.
  - [ ] H5 after H4.
  - [ ] H6 after H5.
- [ ] Hold the file boundaries.
  - [ ] H1 touches only `packages/core/src/session-log/**`, `packages/contracts/src/{session-log,events}.ts`, `apps/web/src/**`, `apps/mobile/{app,lib,components}/**`, `packages/adapters/src/executor.ts` (unread and stale comments) and `packages/core/src/speech-text.ts`.
  - [ ] H2 owns `packages/core/src/helper-profile.ts`, `packages/adapters/src/runtime-worker/**`, `packages/adapters/src/builtin-tools.ts` and `packages/adapter-kit/src/types.ts`.
  - [ ] H3, H4 and H5 own `packages/db/**`, `packages/db/prisma/**`, `packages/adapters/src/executor.ts` and `packages/contracts/src/{ids,session-log}.ts`.
- [ ] Hold the review gate. H1, H4 and H6 change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open each slice PR ready, never draft, per **Opening a PR**, with `gh pr create --base feature/helpers`. Only the feature PR is draft, per `AGENTS.md`.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on.
- [ ] Run `pnpm test:e2e:affected` before every push, and the full `pnpm test:e2e` only when it asks to.
- [ ] Run `/simplify` before each commit and `/no-comments` before review. Run the `test-audit` skill on every slice that adds or edits tests.
- [ ] Triage every Bugbot and security-reviewer comment per `.claude/skills/poteto-mode/references/bugbot-triage.md`.
- [ ] Merge `feature/helpers` into the slice branch before the code-ready report. Never rebase or force-push `feature/helpers`, and keep it current by merging `main` into it.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the swarm per `.claude/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner, including a defect that a lane filed as a note. A new head gets a fresh swarm and a fresh verdict, except for results that stay valid under the patch-id rule in `.claude/skills/poteto-mode/playbooks/shipping.md`.
- [ ] On a clean verdict, the owner merges its slice into `feature/helpers` with a merge commit. A review-gated slice waits for the operator first. Results stay valid across a merge of `feature/helpers` only when the patch-id is unchanged.

### Boot recipe, for every live lane

Each live lane runs in its own isolated worktree (`isolation: "worktree"`) at the PR head. Web and desktop lanes drive through the **run** skill plus the browser tools. Worker lanes drive through Bash. Mobile lanes drive through `pnpm test:mobile-screenshots` and its Maestro flows.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] Run `pnpm install --frozen-lockfile` and `pnpm --filter @tangow/db exec prisma generate`. Start `pnpm dev` with the local worker provider and the testkit model emulator. Wait for the web app to answer on its dev port.
- [ ] Deliver input only by typing in the composer through the browser tools, or through `pnpm test:worker-live` for worker lanes. Read-only diagnostics are the debug-mode run details, the API logs and `pnpm --filter @tangow/db exec prisma studio`.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## Remove helper cards from the conversation (H1)

**Depends on.** None.

**Files.**

- [ ] Edit `packages/core/src/session-log/project-ui.ts`.
- [ ] Edit `packages/core/src/session-log/run-fold.ts`.
- [ ] Edit `packages/core/src/session-log/child-sessions.ts`.
- [ ] Edit `packages/contracts/src/session-log.ts` and `packages/contracts/src/events.ts`.
- [ ] Edit `apps/web/src/pages/shell/thread-row.tsx`, `apps/web/src/components/AgentSteps.tsx` and `apps/web/src/pages/shell/session-view.tsx`.
- [ ] Delete `apps/web/src/components/TaskCard.tsx` and `apps/web/src/components/TaskCard.test.tsx`.
- [ ] Edit `apps/mobile/app/thread.tsx`, `apps/mobile/components/agent-steps.tsx` and `apps/mobile/lib/session-sheet.ts`.
- [ ] Edit `packages/adapters/src/executor.ts`, `packages/core/src/speech-text.ts`, the `apps/web/src/locales/*/messages.po` catalogs and `apps/mobile/lib/locales/*.ts`.

**Build.**

- [ ] Drop the `kind:"subagent"` items, finished and running, from `ThreadItemSchema`, and the code in `project-ui.ts` that builds them (`subagentItem`, `subagentInput`, the running placeholder and the stray-entry case).
- [ ] Delete the `splitAtHelpers` option in `run-fold.ts` and its call site. Keep `subagent` as a tool answer there, since inference replay reads it.
- [ ] Narrow `ChildSession.kind` and `origin.kind` to routines. Drop the helper origin label from risen approval cards while keeping the approval itself.
- [ ] Delete `SubagentCard` on web and the `case "subagent"` row and `TaskCard` on mobile, plus their strings when no other caller uses them.
- [ ] Stop marking the thread unread when a helper finishes (`subagentMarksUnread`) and stop speaking "starting a subagent" in `speech-text.ts`.
- [ ] Move the helper's detail into debug mode. The `steps` block's call object in `packages/contracts/src/events.ts` gains an optional `sessionId`, which the projection fills for a `run_subagent` call from its `subagent` answer. With debug mode on, that call in the steps block opens the helper's own session view, with its steps, its run details and its result, through the session view web and mobile already have. `onOpenSession` is passed from the row context (`thread-row.tsx` on web, `thread.tsx` on mobile) into `AgentSteps` and `agent-steps.tsx`, which have no open prop today. A sync helper becomes openable once its answer lands, as today, and H4 covers the live case. With debug mode off, nothing about the helper renders.

**You see.**

- [ ] A web thread where the bot used a helper shows only the bot's reply, with no helper card and no origin label, at desktop width and at 390x844.
- [ ] The same thread on the iOS app shows only the bot's reply.
- [ ] With debug mode on, the steps block lists `Run subagent` with its brief and result, and tapping it opens the helper's session with its own steps and run details, on web and on iOS.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/core/src/session-log/project-ui.test.ts` and `project-thread-view.test.ts` drop the card cases and gain one case asserting that a thread with a `run_subagent` call and its `subagent` answer projects to the exact list of message items, with no item of kind `subagent`. Run `pnpm exec vitest run packages/core/src/session-log`.
- [ ] The same projection case asserts that the `run_subagent` call in the `steps` block carries the helper's literal `sessionId`.
- [ ] `project-inference.test.ts` keeps its helper replay cases unchanged and still passes. Run `pnpm exec vitest run packages/core/src/session-log/project-inference.test.ts`.
- [ ] `apps/web/src/lib/thread-events.test.ts` is rewritten without the `scout` row. Run `pnpm --filter @tangow/web test`.
- [ ] Run `pnpm --filter @tangow/mobile test` and `pnpm --filter @tangow/contracts test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Send "use a helper to summarize this" to a bot on the scripted runtime at trunk and at head. Save `h1-trunk-vs-head.png`. Pass when trunk shows a helper card and head shows only the bot reply.
- [ ] Lane 2. The same thread at 390x844 in the web app. Save `h1-phone.png`. Pass when no helper card or origin label renders.
- [ ] Lane 3. The same thread in Electron through the run skill. Save `h1-desktop.png`. Pass when no helper card renders.
- [ ] Lane 4. The same thread on iOS through `pnpm test:mobile-screenshots`. Save `h1-ios.png`. Pass when no helper card renders.
- [ ] Lane 5. Turn on debug mode, open the steps block of that reply and tap the `Run subagent` call, on web and on iOS. Save `h1-debug-helper.png`. Pass when the helper's session opens with its own steps, run details and result.
- [ ] Lane 6. A helper requests an approval. Save `h1-approval.png`. Pass when the approval card renders and carries no helper origin label.
- [ ] Lane 7. Send a second message after the helper turn. Save `h1-follow-up.png`. Pass when the bot's answer uses the helper's result, proving replay still works.
- [ ] Lane 8. Leave the thread before the helper finishes and come back. Save `h1-unread.png`. Pass when the thread is marked unread only by the bot's reply, never by the helper alone.
- [ ] Lane 9. Use voice playback on the reply. Save `h1-speech.png`. Pass when the spoken text has no "starting a subagent" phrase.
- [ ] Lane 10. A routine run posts into the thread. Save `h1-routine-origin.png`. Pass when the routine origin label still renders.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Thread projection time for a 500-entry session with 20 helper calls, the `project-thread-view` benchmark in `docs/performance.md`.
- [ ] Probe. Run the benchmark five times at trunk and five at head, interleaved.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail when the head median is more than 5 percent slower than trunk.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2 and 4 screenshots into `docs/assets/helpers/h1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a helper turn at head on a lane VM. Save it as `docs/assets/helpers/h1-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] `feature/helpers` merged into the slice after the verdict, patch-id unchanged.
- [ ] The owner merges H1 into `feature/helpers` after the operator's click.

## Apply a managed profile to a sync helper (H2)

**Depends on.** None.

**Files.**

- [ ] Create `packages/core/src/helper-profile.ts` and `packages/core/src/helper-profile.test.ts`.
- [ ] Edit `packages/adapters/src/runtime-worker/session.ts` and `packages/adapters/src/runtime-worker/guest-input.ts`.
- [ ] Edit `packages/adapters/src/builtin-tools.ts`, `packages/adapters/src/executor.ts` and `packages/adapter-kit/src/types.ts`.

**Build.**

- [ ] Define the `HelperProfile` type in `helper-profile.ts`, `{ name, description, allow?: readonly string[], block?: readonly string[], exclusive?: HelperResource, model?: { provider: string; id: string }, instructions: string }`, the closed type `HelperResource = "computer"`, and the typed registry `HELPER_PROFILES: readonly HelperProfile[]`, empty in this program. A malformed profile fails typecheck, so there is no parser, no schema and no file to read.
- [ ] The controller session takes the profile list from `AgentRunRequest`, which the executor fills with `HELPER_PROFILES`. Tests pass their own list there, the same way they pass tools. Profiles are managed only for now. Bot and shared sources come later, in files, with their own design.
- [ ] Add an optional `helper` field to the `run_subagent` schema. Without it, the call keeps today's behavior. An unknown name returns a tool error listing the available profiles.
- [ ] Add `selectTools(catalog, { allow, block })` to `helper-profile.ts`. It keeps every tool marked `where: "guest"`, the native harness tools, plus each tool matching `allow`, then drops each tool matching `block`, native ones included. A pattern is an exact name or a prefix ending in `*`. `isHelperTool` applies last for every helper, so a helper never delegates. A call without `helper` keeps today's tool list.
- [ ] Build a profiled helper's tools from the bot's full tool catalog, not from the parent's visible list, so a tool hidden from the parent is still granted to the helper that needs it.
- [ ] Add `MAIN_BOT_BLOCKED_TOOLS: readonly string[] = []` and pass the main bot's tool list through `selectTools` with that block list and an allow-all pattern, in `guest-input.ts`, and refuse a blocked tool in `callTool`. `exclusive` touches no tool. The next phase adds `computer_*` and `browser_*` to the list when it ships `computer-use`.
- [ ] Set the helper's instructions to the fixed preamble plus the profile body plus the call's `instructions`. Pick its model as call arguments, then the profile's `model`, then the parent's model.
- [ ] Keep each helper's selected tool set in the controller session for its `helper:N` agent and refuse any tool call outside it with `unknown_tool`.
- [ ] Append one `<available_helpers>` block to the parent's instructions in `guest-input.ts`, name and description only, and only when a profile exists.

**You see.**

- [ ] A parent calls `run_subagent` with `helper: "researcher"` and the guest receives a `subagent.start` whose tools equal the native tools plus the profile's `allow` minus its `block`.
- [ ] A helper that calls a tool outside its selected set gets `unknown_tool`.
- [ ] With `HELPER_PROFILES` empty, the parent's prompt and tools are byte-identical to trunk.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `helper-profile.test.ts` gains literal `selectTools` results for a catalog of native and Tangow tools, with no lists, with exact and prefix `allow` patterns, and with a `block` that removes a native tool. Run `pnpm exec vitest run packages/core/src/helper-profile.test.ts`.
- [ ] `packages/testkit/src/runtime-worker-subagent.test.ts` passes a fixture profile list on the request, extends its `subagent.start` `toEqual` with a profiled call, and asserts the exact tools, instructions and model. Run `pnpm exec vitest run packages/testkit/src/runtime-worker-subagent.test.ts`.
- [ ] The same file gains a case with a block list on the main bot, passed on the request like the profiles. It asserts that the parent lacks the blocked tool and gets `unknown_tool` calling it, keeps its native tools, and that a profile allowing that tool grants it to its helper.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run a sync `run_subagent` without `helper` through `pnpm test:worker-live` at trunk and head with an empty registry. Save `h2-trunk-vs-head.png`. Pass when results, prompts and tool lists match.
- [ ] Lane 2. Add one profile to `HELPER_PROFILES` on the lane branch and send a message. Save `h2-loaded.png`. Pass when the parent prompt in debug run details lists it in `<available_helpers>` once.
- [ ] Lane 3. A profile with no `allow` and no `block`. Save `h2-natives.png`. Pass when the helper's model request lists exactly the native harness tools.
- [ ] Lane 4. A profile allowing two Tangow tools and blocking `bash`. Save `h2-allow-block.png`. Pass when the helper's model request lists the native tools without `bash`, plus those two.
- [ ] Lane 5. The profiled helper tries a tool outside its selected set. Save `h2-refused.png`. Pass when it gets `unknown_tool`.
- [ ] Lane 6. A profile with `model` set, then the same call with `model_provider` and `model_id`. Save `h2-model.png`. Pass when the first goes to the profile's model and the second to the call's model.
- [ ] Lane 7. Put `computer_*` in `MAIN_BOT_BLOCKED_TOOLS` on the lane branch with a profile allowing it. Save `h2-main-block.png`. Pass when the parent's model request keeps `bash` and lacks `computer_observe`, and the helper's request has both.
- [ ] Lane 8. A helper profile allows `run_subagent`. Save `h2-depth.png`. Pass when the helper's tools still lack it.
- [ ] Lane 9. A call names an unknown profile. Save `h2-unknown.png`. Pass when the parent gets a tool error listing the available profiles.
- [ ] Lane 10. A web thread on the scripted runtime with a profiled helper. Save `h2-web.png`. Pass when the thread shows only the bot reply and debug mode shows `helper: "researcher"` in the call input.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Prompt tokens of the parent's first model request with ten profiles, and run start time from `continueRun` to the guest's first model request.
- [ ] Probe. Run the worker-live helper lane five times at trunk and five at head, interleaved, reading the emulator's request log.
- [ ] Baseline. Record the trunk median of both first.
- [ ] Rule. Fail when the catalog adds more than 60 tokens per profile or run start grows by more than 20 ms.

**Review gate.** None. H2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] `feature/helpers` merged into the slice after the verdict, patch-id unchanged.
- [ ] The owner merges H2 into `feature/helpers`.

## Hold an exclusive resource for one helper at a time (H3)

**Depends on.** H2.

**Files.**

- [ ] Edit `packages/db/prisma/schema.prisma` and create one migration under `packages/db/prisma/migrations/`.
- [ ] Edit `packages/adapters/src/executor.ts`.
- [ ] Edit `packages/adapter-kit/src/types.ts`.

**Build.**

- [ ] Add `Run.exclusive String?`, written only from a `HelperResource`, and a partial unique index on `(botId, exclusive)` where the status is in `ACTIVE_RUN_STATUSES`. The lock is the helper's own run row, so finishing, failing or cancelling the run releases it with no extra lifecycle code.
- [ ] `startSubagent` writes the profile's `exclusive` on the helper run. A unique violation becomes a tool error that names the holding helper's id and profile, so the parent can wait, stop it or give up.

**You see.**

- [ ] Two parallel sync helpers with the same exclusive profile. The second gets "computer is held by helper " and the first runs.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/testkit/src/executor-worker-helper.test.ts` gains a case on PGlite where the second exclusive helper gets the literal error and a third succeeds after the first finishes. Run `pnpm exec vitest run packages/testkit/src/executor-worker-helper.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Two parallel sync helpers without `exclusive` at trunk and head. Save `h3-trunk-vs-head.png`. Pass when both run on both sides.
- [ ] Lane 2. Two parallel helpers with the same exclusive profile. Save `h3-conflict.png`. Pass when the second gets the holder's id.
- [ ] Lane 3. The first helper finishes, then a new exclusive helper starts. Save `h3-release-finish.png`. Pass when it runs.
- [ ] Lane 4. The first helper fails. Save `h3-release-fail.png`. Pass when the next exclusive helper runs.
- [ ] Lane 5. The user presses Stop during an exclusive helper. Save `h3-release-stop.png`. Pass when the next turn's exclusive helper runs.
- [ ] Lane 6. An exclusive helper and a helper without `exclusive`. Save `h3-mixed.png`. Pass when both run in parallel.
- [ ] Lane 7. Two bots in the same space with the same exclusive profile. Save `h3-two-bots.png`. Pass when both run.
- [ ] Lane 8. The worker dies during an exclusive helper and the reconciler expires the lease. Save `h3-crash.png`. Pass when the lock is released once the run is terminal.
- [ ] Lane 9. Apply the migration to a copy of a populated dev database. Save `h3-migration.png`. Pass when it applies with no error and existing runs keep `exclusive` null.
- [ ] Lane 10. A web thread on the scripted runtime with a lock conflict. Save `h3-web.png`. Pass when the user sees only the bot's reply.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `startSubagent` transaction time.
- [ ] Probe. Time 200 helper starts on PGlite at trunk and head, interleaved in batches of 20.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail when the head median is more than 2 ms slower.

**Review gate.** None. H3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] `feature/helpers` merged into the slice after the verdict, patch-id unchanged.
- [ ] The owner merges H3 into `feature/helpers`.

## Run a background helper that wakes the parent (H4)

**Depends on.** H1 and H3.

**Files.**

- [ ] Edit `packages/contracts/src/ids.ts` and `packages/contracts/src/session-log.ts`.
- [ ] Edit `packages/db/src/events.ts` and `packages/db/prisma/schema.prisma` with one migration.
- [ ] Edit `packages/adapters/src/executor.ts`.
- [ ] Edit `packages/adapters/src/builtin-tools.ts`.
- [ ] Edit `packages/adapters/src/runtime-worker/session.ts`.
- [ ] Edit `packages/core/src/session-log/project-inference.ts`.

**Build.**

- [ ] Add `background: boolean` to `run_subagent`. A background call returns `{ helperId }` at once, where `helperId` is the child run id. The `tool.result` payload gains an optional `sessionId` holding the child session id, and `run-fold.ts` reads `sessionId` from either a `subagent` or a `tool.result` answer, so the debug steps block from H1 opens the child.
- [ ] Add the `helper` trigger to `RunTrigger`, `RUN_STARTERS`, `RunActivityRowSchema` and `sessionRunTrigger`, and add the missing `subagent` trigger the spike found. A `helper` run maps to `{ kind: "subagent", entryId }` with the spawning call as entry. It is what tells a background child apart from a sync one.
- [ ] In one transaction the background call creates the child session of kind `subagent`, a queued child run with `parentRunId`, trigger `helper`, `exclusive` and the profile name, then enqueues `runContinueJob`. The child's controller looks the profile up by name in `HELPER_PROFILES`, so a deploy in between gives the child the new definition. When the profile is gone, the child finishes as `failed` with a report saying the profile is unknown, so the parent wakes instead of waiting.
- [ ] In `continueRun`, a run with `parentRunId` reads history from its own session only, its prompt is the brief, its tools and instructions come from its profile, and its model calls carry the child run id as agent id.
- [ ] Apply the three filters the spike proved. Exempt `helper` runs from the `strandedHelpers` cancel in `finalizeRun`. Add `parentRunId: null` to the run lookups in `claimSteering` and `createSteeringContinuation`.
- [ ] Add a `helper.report` entry type `{ helperId, profile, status, report }` with audience `{ inference: "yes", ui: false }`, rendered to the model as `<helper_report>`. The report is the child's final answer, capped at 4,000 characters, with a pointer to the child session for `search_runs`.
- [ ] The child's finalize writes the report only when the child completed or failed. A cancelled child, from `helper_stop` or the composer Stop, writes no report and wakes no one.
- [ ] Wake through `createSteeringContinuation`, which `finalizeRunOnce` already calls under the thread lock for every run, parent and child alike. Add one branch. When no steering is pending, no top-level run is active and the main session holds a report newer than the last top-level `run.started`, queue a `follow_up` run with no source message. Pending steering already starts a `follow_up` run that sees the report. A report that lands mid-turn therefore wakes the parent once that turn ends.

**You see.**

- [ ] The bot answers "I've started that, I'll come back with it" and finishes its turn. The helper keeps running. When it finishes, the bot posts its result without any user message.
- [ ] With debug mode on, the parent's `run_subagent` call opens the background helper's session, live while it runs and complete once it ends. Run details show the child with trigger `helper` and the woken run with trigger `follow_up`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Promote the spike's scenarios into `packages/testkit/src/executor-background-helper.test.ts` on PGlite. Assert that the child is still `running` after the parent completes, that the child's history is exactly its brief, that a user message during the child starts a `user` run the child cannot claim, and that the woken parent's model input contains the literal report. Run `pnpm exec vitest run packages/testkit/src/executor-background-helper.test.ts`.
- [ ] Assert in the same file that a report landing while the parent runs yields exactly one `follow_up` run after the parent finishes, and that a cancelled child writes no report.
- [ ] `project-inference.test.ts` gains a literal case for the `<helper_report>` rendering, and `project-ui.test.ts` asserts that `helper.report` produces no thread item. Run `pnpm exec vitest run packages/core/src/session-log`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Ask for a long task at trunk and head. Trunk has no background mode, so record that and gate the head behavior plus the woken reply the user waits for. Save `h4-trunk-vs-head.png`. Pass when trunk blocks until the helper ends and head replies at once, then posts the result unprompted.
- [ ] Lane 2. The user keeps chatting while the helper runs. Save `h4-chat-during.png`. Pass when every user message gets its own reply and the helper keeps running.
- [ ] Lane 3. The helper finishes while the bot is mid-reply. Save `h4-report-mid-turn.png`. Pass when exactly one woken reply follows the current reply.
- [ ] Lane 4. Two background helpers finish close together. Save `h4-two-reports.png`. Pass when both reports reach the bot and no report is lost or doubled.
- [ ] Lane 5. The helper fails. Save `h4-failed.png`. Pass when the bot is woken with a failed report and tells the user.
- [ ] Lane 6. Restart the API while the helper runs. Save `h4-restart.png`. Pass when the reconciler resumes the child and the report still arrives.
- [ ] Lane 7. The same flow at 390x844 on web and on iOS. Save `h4-phone.png`. Pass when no helper card or report entry renders.
- [ ] Lane 8. The same flow in Electron. Save `h4-desktop.png`. Pass when only the bot's replies render.
- [ ] Lane 9. Debug mode on, open run details. Save `h4-debug.png`. Pass when the child shows trigger `helper` and the woken run shows `follow_up`.
- [ ] Lane 10. Find the child run's trace in Langfuse. Save `h4-langfuse.png`. Pass when the child's generations appear under its own run.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from the user's message to the bot's first reply when the bot starts a 60-second task. As diff-added work, also the time from the child's finish to the woken reply.
- [ ] Probe. Run the lane 1 scenario three times at trunk and three at head, interleaved, on the local worker provider with the model emulator.
- [ ] Baseline. Record the trunk median first, which includes the whole task.
- [ ] Rule. Fail when the head's first reply is not at least 50 seconds faster than trunk, or when the child-finish-to-woken-reply time exceeds 5 seconds plus one worker start.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2 and 7 screenshots into `docs/assets/helpers/h4-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a background helper flow on a lane VM. Save it as `docs/assets/helpers/h4-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] `feature/helpers` merged into the slice after the verdict, patch-id unchanged.
- [ ] The owner merges H4 into `feature/helpers` after the operator's click.

## Let the bot and its helpers talk, check and stop, with examples (H5)

**Depends on.** H4.

**Files.**

- [ ] Edit `packages/adapters/src/builtin-tools.ts` and `packages/adapters/src/executor.ts`.
- [ ] Edit `packages/db/src/events.ts` and `packages/db/src/cancel-runs.ts`.
- [ ] Edit `packages/contracts/src/session-log.ts`, `packages/core/src/session-log/project-inference.ts` and `packages/adapters/src/runtime-worker/session.ts`.
- [ ] Edit `apps/api/src/thread-target.ts`.
- [ ] Create `docs/examples/helpers/README.md` and `packages/testkit/src/helper-profiles.fixture.ts`.
- [ ] Create `docs/examples/helpers/parallel-research/SKILL.md`.
- [ ] Edit `skills/README.md` and `CHANGELOG.md`.

**Build.**

- [ ] Add `helper_status`, `helper_message` and `helper_stop` to the builtin tools and to `DELEGATION_TOOL_NAMES`, so `isHelperTool` keeps them from helpers.
- [ ] Add `ask_parent({ question })`. The controller adds it only to runs with trigger `helper`, never to the main bot or a sync helper. A sync helper runs while its parent waits on it, so a question would deadlock both; it keeps returning its result.
- [ ] Add `pauseRunForParent` next to `pauseRunForInput` in `packages/db/src/events.ts`. In one transaction under the thread lock it moves the child from `running` to `waiting_input`, parks the attempt so the VM is released, and appends `helper.question { helperId, question }` to the parent's main session with audience `{ inference: "yes", ui: false }`, rendered to the model as `<helper_question>`. It posts no ask card and sends no notification, unlike the `ask_user` path. The exclusive lock stays held, since `waiting_input` is an active status.
- [ ] Count `helper.question` like `helper.report` in the H4 wake rule, so a question wakes the parent once its current turn ends.
- [ ] Add `parentRunId: null` to the reads that treat a waiting run as waiting on the user, the thread snapshot in `apps/api/src/thread-target.ts` and `proposalPreflight` in `executor.ts`, so a waiting helper neither shows the bot as waiting on the user nor blocks the parent's own approval cards.
- [ ] `helper_status` returns the bot's active helpers in this thread, `{ helperId, profile, brief, status, startedAt, question? }`, where a helper waiting on its parent shows `waiting` and its question. It is a status, not a todo list. Planning stays with the harness's own tools. Finished helpers are already in the mainline as reports.
- [ ] `helper_message` routes by the helper's status under the thread lock. Any message to a waiting helper answers its question. In one transaction it writes the `tool.result` for the paused `ask_parent` call, so resume does not replay the call, moves the child from `waiting_input` to `queued`, and enqueues it. The task prompt is not rewritten. Otherwise it writes a `SteeringMessage` with `runId` set to the child, in the child's session, and `claimSteering` accepts a targeted row outside the main session only for its own run. A message to a finished helper returns an error saying it ended.
- [ ] An approval-gated call from a background helper keeps the H4 error, which now tells the helper to ask its parent. The parent does the action itself under its own approval, or asks the user. Forwarding a verified approval to the helper is deferred until H6 shows it is needed.
- [ ] `helper_stop` takes a `helperId` or `all` and cancels through `cancelRunsInTransaction` plus `jobs.cancel(runJobKey(id))`. The child's guest aborts on its next lease renewal. The spike found it does not today with a cancelled child, so the owner proves it on the real worker.
- [ ] Write `researcher`, a read-only profile meant for background research, that blocks `bash`, `edit` and `write`, and `screen-operator`, which allows `computer_*`, `browser_*` and `search_runs` and holds `computer`. Both are typed fixtures in `packages/testkit/src/helper-profiles.fixture.ts`, outside `HELPER_PROFILES`, so they never ship. Tests and the demo pass them on the request.
- [ ] Write one example routing skill that says when to start `researcher` in background, how to write its brief and what to do with the report.
- [ ] Document the profile type and the demo steps in `docs/examples/helpers/README.md`. Link it from `skills/README.md`.
- [ ] Add one `#### Added` entry dated for the day the feature PR merges. Draft, **Bots can hand long tasks to a helper and keep talking.** The bot comes back with the result on its own when the helper finishes, on web, desktop and mobile. Add one `#### Changed` entry. Draft, helper cards no longer appear in conversations.

**You see.**

- [ ] The bot answers "where are you at?" from `helper_status` without stopping the helper.
- [ ] The user says "actually, also check trains" and the running helper's next model request contains that text.
- [ ] A background helper asks "which dates?". The bot is woken with the question, asks the user in its own words, gets an answer, answers the helper, and the helper resumes and reports. The thread shows only the bot's messages.
- [ ] The user says "stop everything" and every helper of the bot in the thread ends as cancelled within one lease renewal, with no report afterwards.
- [ ] Adding both fixtures to `HELPER_PROFILES` and `computer_*` and `browser_*` to `MAIN_BOT_BLOCKED_TOOLS` in a dev checkout makes the bot's prompt list them, removes computer and browser tools from the main bot, and lets the bot run the demo end to end.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/testkit/src/executor-background-helper.test.ts` gains literal cases for the status list, a steered message the parent cannot claim, `helper_stop` on one id and on `all`, a helper that calls `helper_status` and gets `unknown_tool`, an `ask_parent` that writes the literal `helper.question`, parks the child, wakes the parent once and resumes with the literal answer as its tool result, a sync helper whose tools lack `ask_parent`, a stop while waiting that cancels with no report, a waiting helper that leaves the thread snapshot and the parent's approval cards unchanged, a resumed helper that does not call `ask_parent` again, and an approval-gated call whose error names `ask_parent`. Run `pnpm exec vitest run packages/testkit/src/executor-background-helper.test.ts`.
- [ ] `helper-profile.test.ts` gains a case asserting the literal tools granted to each fixture and hidden from the main bot. Run `pnpm exec vitest run packages/core/src/helper-profile.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Ask "where are you at?" during a long task at trunk and head. Trunk has no helper tools, so record that and gate the head's status answer. Save `h5-trunk-vs-head.png`. Pass when head answers with the helper's brief and elapsed time.
- [ ] Lane 2. Add an instruction during the task. Save `h5-message.png`. Pass when the helper's next model request contains it.
- [ ] Lane 3. Stop one of two helpers, then all. Save `h5-stop.png`. Pass when the first stop ends only that one, the second ends the rest, and no report wakes the bot afterwards.
- [ ] Lane 4. A background helper asks its parent a question that needs the user. Save `h5-ask-parent.png`. Pass when the bot asks the user in its own words, relays the answer, the helper resumes from where it stopped, and no helper question renders in the thread.
- [ ] Lane 5. Stop a helper that holds an exclusive lock. Save `h5-stop-lock.png`. Pass when a new exclusive helper starts right after.
- [ ] Lane 6. Watch the worker logs after `helper_stop`. Save `h5-guest-abort.png`. Pass when the child's guest exits within one lease renewal.
- [ ] Lane 7. With the routing skill installed, send a long research request, then a short question. Save `h5-routing.png`. Pass when the first starts `researcher` in background and the second gets a direct answer.
- [ ] Lane 8. Ask the bot to open a website with `screen-operator` installed, twice at once. Save `h5-screen.png`. Pass when the bot delegates, has no direct computer tool, and the second task waits on the lock.
- [ ] Lane 9. Follow the demo steps in `docs/examples/helpers/README.md` verbatim on a fresh dev setup, at desktop width, at 390x844, in Electron and on iOS. Save `h5-demo.png`. Pass when every step works as written and only bot replies render.
- [ ] Lane 10. Read the CHANGELOG entries against the running feature. Save `h5-changelog.png`. Pass when each sentence describes something a lane observed.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from `helper_stop` to the child's guest exit, `helper_status` latency with five active helpers, and main bot prompt tokens with `screen-operator` installed.
- [ ] Probe. Run lanes 3, 6 and 8 three times at head. Trunk lacks the tools, so the probe also runs the composer Stop and the same website request at trunk and head, interleaved.
- [ ] Baseline. Record the trunk composer-Stop-to-guest-exit median and the trunk prompt tokens first.
- [ ] Rule. Fail when `helper_stop` to guest exit exceeds the trunk composer Stop median by more than 1 second, when `helper_status` exceeds 100 ms, or when the head prompt with `screen-operator` is not smaller than trunk.

**Review gate.** None. H5 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] `feature/helpers` merged into the slice after the verdict, patch-id unchanged.
- [ ] The owner merges H5 into `feature/helpers`.

## Ship a computer-use profile and benchmark it on a browser task (H6)

**Depends on.** H5.

**Files.**

- [ ] Edit `packages/core/src/helper-profile.ts`.
- [ ] Create `packages/testkit/src/bench/travel-site/` with a static multi-page travel site and its expected answers.
- [ ] Edit `packages/testkit/src/cli/evals.ts`, `packages/testkit/src/evals/runner.ts` and `packages/testkit/src/evals/cases.ts`.
- [ ] Edit `packages/adapters/src/executor.ts` and the `createApp` options it is built from.
- [ ] Create `docs/benchmarks/helpers-computer-use.md`.
- [ ] Edit `CHANGELOG.md`.

**Build.**

- [ ] Connect GLM 5.3 Flash through OpenCode Go as a `ModelConnectInput`, the connection JSON `pnpm` evals already read, with no provider-specific environment variable. Before anything else, prove one tool call works, and declare whether it reads images per `model-modalities.ts`, since `computer_observe` returns screenshots. The key stays in a file outside the repo and reaches the run only as a connection secret. Estimate the total run count against the key's 12 hour validity before starting.
- [ ] Build the travel site. A search with destination, date picker and duration range, paginated results, detail pages whose itinerary lists the cities, and a quote form that shows the total for 2 adults only once filled. It holds distractors, a cheaper circuit without Hiroshima and one departing in March. It is copied into the Docker computer and served there, so no external site is involved.
- [ ] Write the benchmark task, "Find the 10 to 14 day Japan circuit departing in April that visits Kyoto and Hiroshima at the lowest price. Give its name, its total price for 2 adults, its duration and its link." The grader compares the four fields with the expected answer, literally.
- [ ] Write three small development tasks on the same site that differ from the benchmark task, such as reading one detail page, filtering by duration, and filling the quote form once.
- [ ] Add the managed `computer-use` profile to `HELPER_PROFILES`. It allows `computer_*`, `browser_*` and `search_runs`, holds `exclusive: "computer"`, and has short instructions grounded in the real tool contracts of `browser_navigate`, `browser_snapshot`, `browser_act`, `browser_run`, `computer_observe`, `computer_act` and `computer_exec`.
- [ ] Iterate the profile instructions on the development tasks only, never on the benchmark task. Try the baseline and at most two variants, three runs each, in one log table of success rate, tool calls and tokens. The instructions freeze before the first benchmark run. The candidates cover observing before acting, preferring the snapshot over screenshots, acting by reference instead of coordinates, checking the result of each action, and a report of done, blocked or evidence.
- [ ] Run the benchmark through the existing evals runner, with two cases, direct and helper, and a Docker computer option replacing the hard-coded fake sandbox in `cli/evals.ts`. Variant A has the main bot use the computer and browser tools directly. Variant B blocks `computer_*` and `browser_*` for the main bot through one `createApp` option that the executor reads in place of the `MAIN_BOT_BLOCKED_TOOLS` constant, so the bot delegates to `computer-use`. Five trials per variant, interleaved A then B, same model, a fresh thread and a fresh computer per trial so browser history and cache cannot carry an answer over.
- [ ] Record per trial the success, the wall time, the time to the first reply, the main bot's context tokens at the end, the total tokens across bot and helper, and the main bot's and the total tool call counts. The runner today drops `subagent` sessions, so it counts the helper's calls separately. Write the table, the medians with min and max, a plain note that five trials per variant only shows large gaps, and the cause of each gap to `docs/benchmarks/helpers-computer-use.md`, per the benchmark checklist.
- [ ] Keep `MAIN_BOT_BLOCKED_TOOLS` empty. Removing the computer and browser tools from every bot is decided on the results, outside this slice.
- [ ] Extend the H5 Added entry in `CHANGELOG.md` with one sentence that bots can hand browser work to a computer helper.

**You see.**

- [ ] The evals run prints one row per trial and the results document shows variant A and variant B side by side.
- [ ] In a variant B run with debug mode on, the parent's `run_subagent` step opens the `computer-use` helper's session with its browser steps.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `helper-profile.test.ts` asserts the literal tools `computer-use` gets from the real catalog and that it holds `computer`. Run `pnpm exec vitest run packages/core/src/helper-profile.test.ts`.
- [ ] The grader has a literal test against a correct answer, a wrong price, the March distractor and the circuit without Hiroshima. Run `pnpm exec vitest run packages/testkit/src/bench`.
- [ ] With `HELPER_PROFILES` holding `computer-use`, the prompt-identity test from H2 is updated to the new catalog line only. Run `pnpm exec vitest run packages/testkit/src/runtime-worker-subagent.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet` at the PR head, per the boot recipe. The lane agents drive on `sonnet`, and every bot and helper inside a lane runs GLM 5.3 Flash.

- [ ] Lane 1. Regression lane against trunk. Run the benchmark task in variant A at trunk and head. Trunk lacks the profile, so record that and gate variant A at head matching trunk's success and tool use. Save `h6-trunk-vs-head.png`. Pass when both succeed with comparable tool calls.
- [ ] Lane 2. The `createApp` block option with variant B on and off. Save `h6-block-seam.png`. Pass when the main bot's model request lacks `browser_navigate` only with the option on.
- [ ] Lane 3. The travel site in the Docker computer. Save `h6-site.png`. Pass when search, pagination, a detail page and the quote form all work by hand.
- [ ] Lane 4. One variant B run with debug mode on. Save `h6-helper-steps.png`. Pass when the helper's session shows its browser steps and the bot's reply holds the four fields.
- [ ] Lane 5. A variant B trial with a stale browser profile left by the previous trial. Save `h6-fresh-computer.png`. Pass when the trial starts with an empty history and no open tab.
- [ ] Lane 6. Two browser tasks at once in variant B. Save `h6-lock.png`. Pass when the second `computer-use` helper is refused with the holder's id and the bot handles it.
- [ ] Lane 7. A helper that cannot find the answer. Save `h6-blocked.png`. Pass when it asks its parent or reports blocked instead of inventing one.
- [ ] Lane 8. The development task log. Save `h6-prompt-log.png`. Pass when every instruction variant has three runs and the frozen one is named.
- [ ] Lane 9. The full benchmark. Save `h6-results.png`. Pass when all ten runs finish and the table is written.
- [ ] Lane 10. Read the results document against the raw rows. Save `h6-explained.png`. Pass when every gap between A and B names its cause from the rows.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Success rate, wall time, main bot context tokens and total tokens for the benchmark task, variant A against variant B.
- [ ] Probe. Five interleaved runs per variant at the PR head with the same model and fresh state, plus variant A once at trunk as the baseline for lane 1.
- [ ] Baseline. Record variant A's medians first.
- [ ] Rule. The slice reports the numbers, it does not gate on them. When either variant succeeds in fewer than three of five trials, the document says the comparison is inconclusive and the owner stops for the operator. It fails only when a gap is reported without its cause.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 4, 5 and 9 screenshots into `docs/assets/helpers/h6-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of one variant B run. Save it as `docs/assets/helpers/h6-review.mp4`.
- [ ] Post the screenshots, the video and the results table in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] `feature/helpers` merged into the slice after the verdict, patch-id unchanged.
- [ ] The owner merges H6 into `feature/helpers` after the operator's click.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] The feature PR lists every slice as merged under `## Sub-PRs`, is marked ready, and has its bot review done.
- [ ] Reply to the operator with the report the execution playbook names, and stop at the feature PR's merge-ready.

## Appendix A. Prototype evidence

### A child run can wake its parent once four things change

The spike ran on the real executor over PGlite through `continueRun`, with hand-scripted guests from `manualLauncher` and `rawGuest`. Branch `spike/helpers-wakeup`, local only. Commit `6eead18e8` holds the unmodified observations and `356f07bed` holds the throwaway tweaks. The test is `packages/testkit/src/spike-helpers-wakeup.test.ts`, and each finding below quotes its `OBS` output. The spike is throwaway and does not merge.

- Q1. A finishing parent cancels its child. Unmodified code printed `background child (trigger helper_bg) ... cancelled`. The child's guest never got `worker.cancel` and kept running. Exempting the trigger from the `strandedHelpers` filter printed `background child ... running`. H4 carries the exemption, and H5 carries the guest abort.
- Q2. An active child blocks and steals steering. A user message while only the child ran started a `user` run as intended. Steering left when the parent finished stayed stranded, because `createSteeringContinuation` counted the child as active, and the child's `steering.claim` returned `"historyText":"Also check trains."`. Adding `parentRunId: null` to both lookups gave the child `"messages":[]` and the parent a `follow_up` run. H4 carries both filters.
- Q3. The wake path works through `continueRun` (`woken parent status: completed`). An unknown trigger does not break `sessionRunTrigger`, which falls back to the source entry. The report reached the model only with no source message or with the report in the prompt. Steering an active parent with a report lost the text, because steering reads only `user.message` blocks. H4 therefore uses a model-visible `helper.report` entry with no source message, and wakes after the running turn instead of steering it.
- Q4. A child runs on its own attempt with its own `subagent` session (`attempt count: 1`), and `interactive` is false. Its history leaked the parent's conversation (`["user:Plan my trip to Lisbon."]`), because `continueRun` reads the thread's main session. The conversation key collides with the parent, inferred from `session.ts` and not observed. H4 reads history from the child's own session and keys model calls with the child run id.
- Q5. A child of the same bot gets `ComputerBusyError` while the parent holds a team computer lease. Dedicated computers have no lease and no conflict. The error reaches the model as a tool error. See Appendix C.
- Q6. `stopThreadRuns` cancels every active run in the thread, children included. The reconciler re-queues queued children and children with expired leases. Each run has its own job key. A finishing child did not mark the thread unread.
- The child's final `done` text was not saved by the hand-written guest. Whether a pi-native transcript keeps it stays unproven. The H4 owner proves it first and persists the final answer if not.

Rerun from a worktree at the spike commit with node 24 on `PATH`.

```
pnpm install --frozen-lockfile --prefer-offline
pnpm --filter @tangow/db exec prisma generate
npx vitest run packages/testkit/src/spike-helpers-wakeup.test.ts | grep OBS
```

### The skills frontmatter parser reads profile lists

`parseSimpleYamlObject` in `packages/core/src/agent-skill.ts` handles inline arrays and indented `- item` lists. This was read from the code, not run, because this worktree had no `node_modules`. The H2 unit cases prove it.

### Stays unproven

- Whether Langfuse shows the child's generations under its own run, or needs a link to the parent's trace. H4 lane 10 checks it.
- Whether a cancelled child's guest stops on lease renewal on the real worker. H5 lane 6 checks it.

## Appendix B. Alternatives rejected

- A fork of the parent's context for each helper. The maintainer rejected it in #386. It loses the parent's prompt cache anyway, since the profile changes instructions and tools, and a background helper would need the history copied across the controller.
- Markdown profile files read by a `loadManagedHelpers` modeled on `loadManagedSkills`. Only the repo writes managed profiles, so files bring a parser, a schema, disk reads and invalid-file handling that no reader needs. The operator chose the typed registry.
- Bot and shared profile sources now, discovered by the guest on the volumes and sent to the controller in a `helpers.profiles` frame. The operator scoped profiles to managed only for now. Volume sources come back with their own design when a bot needs to write its own profiles.
- Reading profiles from the controller's DB skills index. It is stale by one run and stores no shared bodies.
- A separate `helper_report` trigger and a `wakeForHelperReports` function. The existing `follow_up` trigger and `createSteeringContinuation` already cover the wake, under the lock every finalize takes.
- Deriving the main bot's hidden tools from profiles, either every tool of an exclusive profile or the tools mapped to its resource. The first takes base tools such as `bash` away from the main bot, and both hide tools by inference. An explicit `MAIN_BOT_BLOCKED_TOOLS` list and per-profile `allow` and `block` lists say the same thing in plain sight.
- A Tangow todo list built from helper state. The operator left planning to each harness's own tools.
- The parent approving a helper's action itself. Approvals record a human's consent under the bot's policy, and the parent would need that same approval for the action. Letting it say yes would turn delegation into a way around approvals.
- `ask_parent` for sync helpers. The parent waits on the sync helper's result, so a question would deadlock both.
- Reusing the whole `ask_user` pause and resume path for `ask_parent`. It posts an ask card, notifies the user and resumes with a `user.message` that claims the user answered. `ask_parent` reuses only the run status change and the attempt parking.
- A separate tool to answer a question. Routing `helper_message` by the helper's status means the parent never has to know whether the helper waits.
- Folding questions into `helper.report`. A report means the helper finished, and every reader would have to tell the two apart.
- Seven slices. The profile registry had no observable behavior alone, and the examples and CHANGELOG belong in the last slice anyway, so they merged into H2 and H5.
- A separate lock table or advisory locks for `exclusive`. A partial unique index on the helper's own run row releases itself on every terminal status.
- Steering the report into an active parent turn. The spike showed steering drops non-user text, and waking after the turn needs no steering changes.
- Keeping helper cards in debug mode. The maintainer chose debug run details and Langfuse as the only trace surfaces, and the steps block already shows the call.

## Appendix C. Risks

- Team computer contention between a parent and its child (H4, H5). Until the next phase removes computer tools from the main bot, a parent that holds a team computer lease blocks its child's computer calls with `ComputerBusyError`. The H5 owner watches lane 8. The next phase removes the conflict by design.
- A cancelled child's guest keeps running (H5). The owner proves the abort on the real worker before merge.
- A helper waiting on a parent that never answers keeps its exclusive lock (H5). The question is in the parent's context and `helper_status` shows it, and the parent can always stop the helper. There is no timeout.
- Lost or doubled reports when the child and the parent finish together (H4). The wake branch runs inside `createSteeringContinuation`, under the thread row lock every finalize already takes. Lanes 3 and 4 watch it.
- The child's final answer may be missing from its session (H4). The owner checks the pi-native transcript first.
- The main bot can still call a tool an exclusive helper uses, and so bypass the lock, until the next phase fills `MAIN_BOT_BLOCKED_TOOLS` (H2, H3). Nothing in this program ships a profile that holds `computer`, so no user hits it.
- Prompt growth from the `<available_helpers>` catalog (H2). The perf rule caps it.
- The mobile surface has no simulator-driving skill in `.claude/skills`. Mobile lanes go through `pnpm test:mobile-screenshots` and Maestro flows, and a missing flow is added in the slice that needs it.
- Ten live lanes per slice on a local worker provider is costly. Lanes that need E2B keys run in CI's worker-live job when local keys are missing, and the owner records which.

## Appendix D. Links and reading list

- Issue #386 and its decision comments, `gh issue view 386 --comments`.
- `apps/web/e2e/AGENTS.md` and the E2E section of the root README.
- `docs/architecture-sessionlog.md` for entry audiences and risen entries.
- H2 and H4 get the `how` skill before building, and H4 gets the `interrogate` skill on its wake design.
- Each owner keeps a `decisions.tsv` trail per the show-me-your-work skill and returns it with its report.

## Appendix E. Founding-engineer review

An independent `founding-engineer` reviewed the seven-slice draft of this plan once. Its verdict was simplify. It kept guest-side discovery with one frame, the partial unique index lock, hiding tools from exclusive profiles, the profile snapshot on the child run, the spike filters and the `helper.report` entry. Each finding and its disposition follow. After the operator scoped profiles to managed only, the guest discovery, the frame and the profile snapshot left the plan, and a second review covered that change and the debug helper view (see the end of this appendix).

1. Cut the ten live lanes per slice and most perf gates. Open. The operator asked for the multi-phase playbook to the letter, and `check-plan.mjs` requires ten lanes and four perf boxes per PR. In H2, lanes that only repeated unit tests were replaced by lanes that need a real worker or surface. The H3 lock lanes still overlap the PGlite case. The H4 perf probe dropped to three runs per side. The operator decides whether to lighten the rule further.

2. Merge the slices from seven to five or four. Accepted in part. The registry merged into H2 and the examples and CHANGELOG merged into H5. The lock stays its own slice H3, because it carries its own migration and a failure mode the unit tests isolate. Shipping H1 straight to `main` is open. `AGENTS.md` sends standalone changes to `main`, and H1 can ship alone. The plan keeps it in the feature by default so the CHANGELOG lands once.

3. Do not bake an empty `/managed-helpers`. Accepted, and superseded by the operator's managed-only scope. Nothing is baked into worker templates.

4. Fold `wakeForHelperReports` into `createSteeringContinuation`. Accepted in H4.

5. Return only active helpers from `helper_status`. Accepted in H5.

6. Drop the program machinery (hourly loop, owners, swarm, videos, decision trails). Rejected. The operator chose this playbook, and `check-plan.mjs` requires those sections. The operator can lighten it at the go.

7. Drop the H2 lanes for a second frame and an oversized profile. Accepted, and superseded. The managed-only scope removed the frame.

8. Use `follow_up` instead of a new `helper_report` trigger. Accepted in H4. `helper` stays, since it tells background children apart from sync ones in `strandedHelpers`.

The reviewer also asked whether a cancel finalizes and writes a report. H4 now states that a cancelled child writes no report and wakes no one, and its unit case asserts it.

### Second review, after the managed-only scope and the debug helper view

The same reviewer role reviewed H1, H2, H4 and Appendix B again. Its verdict was simplify, with small fixes. It kept the optional `sessionId` on the steps call, since a call object holds neither a session nor a run id. The operator then replaced `loadManagedHelpers` with the typed registry `HELPER_PROFILES`, which removes the file handling.

1. Say where a background call records the child session id. Accepted in H4, as an optional `sessionId` on `tool.result` that `run-fold.ts` reads from either answer type.

2. Say what happens when the profile changed or disappeared before the child starts. Accepted in H4. A changed profile applies as deployed, and a missing one fails the child with a report.

3. Drop the profile name on the `subagent` payload. Accepted. The call input already shows `helper`.

4. Drop the API restart in H2 lane 2. Superseded by the typed registry.

5. State that a running sync helper is not openable in debug. Accepted in H1.

6. Say how the open action reaches the steps view. Accepted in H1.

### Third review, on `ask_parent`

The same reviewer role reviewed the H5 change that lets a background helper ask its parent. Its verdict was simplify. It kept background only, the lock held while waiting, `helper_message` answering a pending question, and `helper.question` as its own entry type.

1. Reuse only the status change, not the `ask_user` card path, which posts a card, notifies and claims the user answered. Accepted, as `pauseRunForParent`.
2. Filter child runs out of reads that treat a waiting run as waiting on the user. Accepted, for the thread snapshot and `proposalPreflight`.
3. Write the `tool.result` before requeueing, so resume does not replay `ask_parent`. Accepted. The H5 owner checks against H4 where the child's brief lives.
4. Keep `ask_parent` away from the main bot. Accepted, offered only to runs with trigger `helper`.
5. Keep the overloaded `helper_message` and say any message to a waiting helper answers it. Accepted.
6. Drop `questionId`. Accepted, since a paused run has at most one question.
7. Keep `helper.question` separate. Accepted.

### Fourth review, on H6

The same reviewer role reviewed the H6 slice. Its verdict was simplify. It kept the `computer-use` profile, the local travel site with distractors and a literal grader, the split between development and benchmark tasks, interleaved trials and an empty `MAIN_BOT_BLOCKED_TOOLS`.

1. Reuse the evals runner instead of a new CLI. Accepted. It already reads a `ModelConnectInput`, runs trials and collects tokens. A Docker computer option replaces its fake sandbox.
2. Name the seam for variant B. Accepted, as one `createApp` option the executor reads in place of the constant.
3. Count the helper's tool calls, which the runner drops. Accepted.
4. A fresh computer per trial. Accepted.
5. Check image support and the 12 hour key budget first, and cap prompt iteration at the baseline plus two variants. Accepted.
6. Report an inconclusive comparison instead of failing on the model's success rate. Accepted.
7. Cut the lanes to six. Rejected, since the playbook requires ten. Two redundant lanes were replaced by lanes on the block seam and the fresh computer, and the lanes now say which model runs where.
8. Say plainly that five trials per variant only shows large gaps. Accepted.
9. Keep the benchmark inside the feature branch or ship it to `main` after the feature merges. Open for the operator. The plan keeps it in H6 by default, as the operator asked for it at the end of this program.

