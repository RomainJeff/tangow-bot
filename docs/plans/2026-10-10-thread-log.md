# Session log plan

A conversation becomes an append-only log of typed entries, one JSON object per entry, stored as rows in Postgres and serialized as JSONL at the edges. The log is keyed by session. A thread owns one main session, a subagent runs in its own child session and leaves one entry in its parent. Messages, the inference context, the compaction summary, run cards and the activity feed are projections of the same entries. Entries form a tree through `parentId`, so rewind and clear append instead of deleting. Readers start at the newest entry of a session and walk parents back to the last `compaction` entry, never the whole session. The program ships on `feature/session-log` as six slices, SL1 to SL6, in that order.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `.claude/skills/poteto-mode/playbooks/autopilot-stack.md`. The slices stack on `feature/session-log`, each slice PR targets the feature branch, and the operator lands the feature PR into `main` after review. SL5 and SL6 are the operator's items that stop at merge-ready.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Decisions already taken

- The log lives in Postgres as a `session_entries` table keyed by `sessionId`. JSONL is the serialization at the edges (file backend, export, import, fixtures), not the production store. The repo's multi-writer shape (API, worker, steering, peer bots, channel mirrors) rules out one file per session. See Appendix B.
- A `sessions` table owns identity and the seq counter. `kind` is `thread` or `subagent`. A thread row points at its main session. A subagent session points at `parentSessionId` and `parentEntryId`, the `tool.call` that launched it, and has no thread of its own.
- One entry per block during a run. The full type list and who reads each type is the audience registry in SL1, summarized in Appendix E.
- An entry is admitted to the log only when it is a durable fact of the conversation, something the user expects to see again a week later. Progress ticks, status transitions, takeover negotiation steps, and facts about the bot or the group stay in the `events` table or their own tables.
- Entries form a tree. Each entry carries `parentId`. The head of a session is its entry with the highest `seq`, so no head pointer exists. A `rewind` entry's parent is the target entry. A `clear` entry has no parent.
- A reader walks from the head up the parent chain and stops at the first `compaction` entry, inclusive. Measured at 3.5 ms for 500 entries inside a 200 000 entry session, Appendix A.
- `run.started` carries a `RunTrigger` sum type (message, routine, webhook, steering, retry, handoff, bot_message) and the model and effort choice.
- Bots talk to each other through three entry types grounded on the existing tools. `handoff` inside a group session, `bot.message.sent` and `bot.message.received` across sessions for `message_bot` and connected agents. One rendering rule in the inference projection, what another bot said is a `<bot_message>` user turn, what this bot said stays on its assistant side. There is one run entry type per fact, not one per trigger source.
- A subagent gets its own `Run` row with `sessionId` and `parentRunId`. It executes in process on the same worker and gate as today. Queueing it to another worker is possible later and changes nothing in the log.
- The UI consumes a `ThreadItem` union (message, run, subagent, handoff, botMessage, divider, effect, note), not `ThreadMessage[]`. Web and mobile render per `kind`. The run card and the subagent card carry the ids the detail views need.
- The existing `events` table stays the ephemeral feed. Appending an entry also emits a `session.entry.appended` event carrying the entry, so the subscribe transport does not change.
- Harness sessions (Claude Code CLI, OpenCode) stay in the harness's own store. The log records only a `harness.session` entry with the id.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show origin/main:.claude/skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `git show origin/main:.claude/skills/swarm/SKILL.md`
  - [ ] `git show origin/main:.claude/skills/run/SKILL.md`
  - [ ] `git show origin/main:.claude/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `git show origin/main:.claude/skills/test-audit/SKILL.md`
  - [ ] `git show origin/main:.claude/skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md`
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Create `feature/session-log` from `main` and open its draft PR to `main` with a `## Sub-PRs` section listing SL1 to SL6 as task items.
- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges into the feature branch.
  - [ ] SL1 is first. It branches from `feature/session-log`.
  - [ ] SL2 after SL1.
  - [ ] SL3 after SL2.
  - [ ] SL4 after SL3.
  - [ ] SL5 after SL4.
  - [ ] SL6 after SL5.
- [ ] Hold the file boundaries. SL1 touches only `packages/contracts/` and `packages/core/`. SL2 touches only `packages/db/`, `packages/adapter-kit/` and `packages/adapters/src/session-log/`. SL3 and SL4 touch `packages/adapters/`, `apps/api/src/`, `apps/worker/src/`. SL5 touches `apps/api/src/`, `apps/web/src/`, `apps/mobile/`. SL6 touches `packages/db/`, `scripts/`, `CHANGELOG.md`, and deletes.
- [ ] Hold the review gate. SL5 changes an interaction. It waits for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use `gh pr create --base feature/session-log`.
- [ ] Run `pnpm lint` and `pnpm check` once before the PR-facing push. Push with hooks on.
- [ ] Run `pnpm test:e2e:affected` before the PR-facing push and follow its escalation.
- [ ] Run `/simplify` before each commit and `/no-comments` before review.
- [ ] Run the `test-audit` skill on every PR that adds or edits tests.
- [ ] Triage every Bugbot and security-reviewer comment per `.claude/skills/poteto-mode/references/bugbot-triage.md`.
- [ ] Rebase onto the current feature branch before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with the feature branch, or on a CI failure that comes from a change on it.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the swarm per `.claude/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner, including a defect that a lane filed as a note. A new head gets a fresh swarm and a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] On a clean verdict the root merges the slice into `feature/session-log` and ticks its item in the feature PR description. The feature PR is marked ready for review after SL6 and the operator lands it.

### Boot recipe, for every live lane

Each live lane runs in its own isolated worktree (`isolation: "worktree"`) at the PR head. Drive through the **run** skill and the browser tools.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] `pnpm install --frozen-lockfile`, start Postgres with `docker compose -f infra/compose/docker-compose.yml up -d postgres`, run `pnpm db:migrate`, then `pnpm dev`. Wait for the API and the web app to answer.
- [ ] Deliver input only through the browser tools. Read-only diagnostics are `psql` selects on `sessions` and `session_entries` and the API logs.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## Define the entry contract, the audience registry and the two projections (SL1)

**Depends on.** None.

**Files.**

- [ ] Create `packages/contracts/src/session-log.ts`.
- [ ] Edit `packages/contracts/src/index.ts`.
- [ ] Create `packages/core/src/session-log/project-inference.ts`.
- [ ] Create `packages/core/src/session-log/project-ui.ts`.
- [ ] Create `packages/core/src/session-log/jsonl.ts`.
- [ ] Create `packages/core/src/session-log/fixtures/` with five JSONL fixtures (linear, rewound, compacted, with a subagent, a group with a handoff and a direct bot message exchange).
- [ ] Create `packages/core/src/session-log/project-inference.test.ts`, `project-ui.test.ts`, `jsonl.test.ts`.

**Build.**

- [ ] `SessionEntrySchema` in `session-log.ts`, a Zod discriminated union on `type` over a shared envelope `{ id, sessionId, seq, parentId, ts, botId?, runId?, type, payload }`. Branded `EntryId`, `SessionId` and `EntrySeq`.
- [ ] Conversation types. `user.message` reuses `MessageBlock` plus reply fields, `clientNonce` and `source`. `assistant.text` reuses `MessageBlock`. `assistant.reasoning` carries `text`. `assistant.ask` and `assistant.choice` carry the question or the options and pause the run; the answer arrives as a `user.message` whose `replyTo` is the ask. `tool.call` carries `{ callId, name, input }`. `tool.result` carries `{ callId, output, isError, artifactIds }`.
- [ ] Run types. `run.started` carries `{ runId, trigger: RunTrigger, model, effort }`. `RunTrigger` is a sum type over `message { entryId }`, `routine { routineId, name, scheduledAt }`, `webhook { routineId }`, `steering { entryId }`, `retry { attempt, previousRunId, reason }`, `handoff { entryId }`, `bot_message { entryId }`. `run.finished` carries `{ runId, status, usage, error?, by? }` where `status` includes `cancelled`.
- [ ] Subagent type. `subagent` carries `{ callId, sessionId, name, model, task, status, result, usage }` and is the only trace a subagent leaves in its parent.
- [ ] Bot to bot types. `handoff` carries `{ fromBotId, toBotId, text }` inside a group session. `bot.message.sent` carries `{ to: Peer, text, intent, hop, exchangeId }` in the sender's session. `bot.message.received` carries `{ from: Peer, fromSessionId, fromEntryId, text, intent, hop, exchangeId }` in the receiver's session, with the delivery key as `clientNonce`. `Peer` is `{ kind: "bot", botId } | { kind: "agent", address }`, which covers connected agents from other owners. `exchangeId` is the first `sent` entry's id, copied through every hop.
- [ ] Side types. `effect.requested`, `effect.edited`, `effect.resolved` carry `effectId`, the proposal and the decision. `computer.control` carries `{ holder: "user" | "bot" }`. `memory.revised` carries the facts learned. `skill.saved` carries the skill id and name. `attachment.added` carries `artifactId` for a file with no carrier message. `session.title` carries the generated or edited title. `system.note` carries `text`.
- [ ] Shape types. `compaction` carries `{ summary, coveredUpToSeq }`. `rewind` carries `{ reason? }` and relies on `parentId`. `clear` has no parent. `harness.session` carries `{ harness, sessionId }`.
- [ ] `ENTRY_AUDIENCE` in `session-log.ts`, one line per type, `{ inference: "yes" | "no" | "context", ui: boolean }`. Both projections and the compaction job read it. Adding a UI-only type later is one line, not a branch.
- [ ] `projectInferenceTurns(entries, options)` in `project-inference.ts`. Input is the chain from the compaction entry to the head, oldest first. Output is the `AgentHistoryTurn[]` shape the executor hands the runtime today, including `parts` for tool replay and the `<compacted_thread_summary>` block from the `compaction` entry. A `subagent` entry renders as the tool result of its `callId`. `assistant.ask` renders as the assistant's own question. `computer.control` and `run.started` with a non message trigger render as one short context line. One rule covers every bot to bot word. What another bot said, a peer's `assistant.text` in a group, a `handoff` addressed to this bot, or a `bot.message.received`, becomes a `<bot_message from=...>` user turn. What this bot said to another, its own `handoff` or `bot.message.sent`, stays on its assistant side.
- [ ] `projectThreadItems(entries)` in `project-ui.ts`. Output is `ThreadItem[]`, a union over `message`, `run`, `subagent`, `handoff`, `botMessage`, `divider`, `effect`, `note`. A `botMessage` item carries direction, peer, intent, `exchangeId` and the linked entry id, so the UI can show whether a sent message was answered. A run's `assistant.*`, `tool.*` and `subagent` entries fold into one `message` item per unbroken stretch, with `blocks` and a `steps` block, the stretch's first entry id as the item id. Any other entry between two of the run's entries, a steering message, an approval, a bot message, closes the stretch and the next entry opens a new one, so seq order is kept. One `run` item per run sits at the run's first entry and carries `runId`, trigger, model, status, usage and duration. The inference projection folds the same way after filtering to the entries the model can see, so an effect or a reasoning entry splits the UI message but not the model turn. A `subagent` entry becomes a `subagent` item carrying `sessionId`. `compaction` and `rewind` become `divider` items. `rewind` and `clear` never remove anything, the chain walk already did.
- [ ] `encodeEntries(entries)` and `decodeEntries(text)` in `jsonl.ts`, one object per line, validated through `SessionEntrySchema`. `readTailFromEnd(open, chunkSize)` reads a byte stream backwards in chunks until the first `compaction` entry, for the file backend in SL2.

**You see.**

- [ ] `pnpm --filter @rakazo/core test` passes and the four fixtures decode, project, and re-encode byte for byte.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `project-inference.test.ts` gains cases for a linear chain, a chain with a rewind that cuts a tool call pair, a chain with a compaction, a chain with a subagent entry, a group session with a peer bot and a handoff projected for each bot, and a `bot.message.received` that wakes a run. Each asserts the literal turn array. Run `pnpm --filter @rakazo/core test`.
- [ ] `project-ui.test.ts` gains the same cases plus a routine triggered run, a cancelled run and an unanswered `bot.message.sent`, and asserts the literal `ThreadItem[]`. Run `pnpm --filter @rakazo/core test`.
- [ ] `jsonl.test.ts` gains a round trip and a backwards read that stops at the compaction entry on a 10 000 line fixture. Run `pnpm --filter @rakazo/core test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk lacks the feature. Record that and gate the behavior the diff adds, the projections and the codec run from fixtures through `pnpm --filter @rakazo/core test` and the full suite stays green at head. Save `core-tests.png`. Pass when the test output lists every new file as passed.
- [ ] Lane 2. Decode a fixture with a tampered line and observe the Zod error names the line. Save `decode-error.png`. Pass when the error carries the line number and the failing field.
- [ ] Lane 3. Project the rewound fixture and print the turns. Save `rewound-turns.png`. Pass when the cut tool call is absent and the user turn before it is present.
- [ ] Lane 4. Project the compacted fixture and print the turns. Save `compacted-turns.png`. Pass when the first turn is the summary block and no entry older than the compaction appears.
- [ ] Lane 5. Project the subagent fixture for inference and for UI. Save `subagent-both.png`. Pass when inference shows a tool result for the call id and UI shows one `subagent` item with the child `sessionId`.
- [ ] Lane 6. Run `readTailFromEnd` on the 10 000 line fixture with a 4 KiB chunk and log bytes read. Save `tail-bytes.png`. Pass when bytes read are under the size of the last 600 lines.
- [ ] Lane 7. Fold a routine triggered run with two tool calls through `projectThreadItems`. Save `ui-fold.png`. Pass when one `run` item names the routine and one `message` item holds a `steps` block with two steps in order.
- [ ] Lane 8. Project the group fixture once per member bot. Save `group-two-views.png`. Pass when the handoff is an assistant turn for the sender and a `<bot_message>` user turn for the receiver, and the receiver's run trigger is `handoff`.
- [ ] Lane 9. Run `pnpm lint` and `pnpm check` at head. Save `lint-check.png`. Pass when both exit zero.
- [ ] Lane 10. Run `pnpm test` at head. Save `full-unit.png`. Pass when the run exits zero.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Trunk lacks the feature. The diff-added work is `projectInferenceTurns` over 500 entries, and the end state the user waits for is unchanged. Measure wall time of the projection over the 500 entry fixture.
- [ ] Probe. A vitest bench in `project-inference.bench.ts`, run five times at head.
- [ ] Baseline. None on trunk. Record the head median as the first baseline.
- [ ] Rule. Absolute budget. Fail when the median exceeds 5 ms for 500 entries.

**Review gate.** None. SL1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto the current feature branch after the verdict, patch-id unchanged.
- [ ] The root merges SL1 into `feature/session-log`.

## Add the sessions and session_entries tables and the SessionLog port (SL2)

**Depends on.** SL1.

**Files.**

- [ ] Edit `packages/db/prisma/schema.prisma`.
- [ ] Create `packages/db/prisma/migrations/<stamp>_sessions/migration.sql`.
- [ ] Create `packages/db/src/sessions.ts`.
- [ ] Edit `packages/adapter-kit/src/interfaces.ts`.
- [ ] Create `packages/adapters/src/session-log/postgres.ts`.
- [ ] Create `packages/adapters/src/session-log/file.ts`.
- [ ] Create `packages/adapters/src/session-log/conformance.ts`.
- [ ] Create `packages/adapters/src/session-log/postgres.test.ts` and `file.test.ts`.

**Build.**

- [ ] `Session` model in `schema.prisma`, mapped to `sessions`, columns `id, spaceId, kind, threadId?, parentSessionId?, parentEntryId?, nextEntrySeq, createdAt`, with `@@index([threadId])` and `@@index([parentSessionId])`. Add `sessionId String @unique` to `Thread`. Add `sessionId` and `parentRunId?` to `Run`.
- [ ] `SessionEntry` model, mapped to `session_entries`, columns `id, sessionId, seq, parentId, type, payload Json, botId?, runId?, createdAt`, with `@@unique([sessionId, seq])`, `@@index([sessionId, type, seq])` and `@@index([runId, seq])`.
- [ ] `SessionLog` interface in `interfaces.ts` with `createSession(tx, input)`, `append(tx, entry)`, `readTail(sessionId)` which returns the chain from the last compaction to the head oldest first, `readPage(sessionId, before?, limit)` which returns the newest `limit` chain entries before an entry, and `readRun(runId)` which returns a run's entries in seq order for the detail views.
- [ ] `appendSessionEntryInTransaction` in `sessions.ts`, which increments `nextEntrySeq` on the session row, sets `parentId` to the current head unless the entry is a `clear` or a `rewind`, inserts the row, and appends a `session.entry.appended` event through `appendEventInTransaction` on the owning thread. Reuse `sanitizeJsonValue` and `assertRunCanWriteHistory`.
- [ ] `PostgresSessionLog` in `postgres.ts`. `readTail` runs the recursive CTE from Appendix A through `prisma.$queryRaw`, stopping at `type = 'compaction'`. `readPage` runs the same CTE bounded by depth. `readRun` is a plain indexed select.
- [ ] `FileSessionLog` in `file.ts`, one `<root>/sessions/<sessionId>.jsonl` per session, append with a per-process lock as one write of the line plus its newline, `readTail` through `readTailFromEnd` from SL1, which skips a torn final line with no trailing newline and refuses any other malformed line. Documented as single-process only.
- [ ] `runSessionLogConformance(makeLog)` in `conformance.ts`. Deterministic and offline. Covers append order, seq uniqueness, the parent invariant, rewind and clear chains, tail stopping at compaction, page boundaries, and two sessions appended concurrently with disjoint chains. Both backend tests call it. Postgres runs it on `@electric-sql/pglite`, already in the lockfile.

**You see.**

- [ ] `pnpm db:migrate` creates `sessions` and `session_entries`, and `pnpm --filter @rakazo/adapters test` passes both conformance runs.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `postgres.test.ts` runs the conformance suite on pglite and adds a concurrent append case with two transactions on one session, asserting the two entries get distinct seqs and a linear parent chain. Run `pnpm --filter @rakazo/adapters test`.
- [ ] `file.test.ts` runs the conformance suite on a temp directory. Run `pnpm --filter @rakazo/adapters test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk lacks the tables. Record that and gate the behavior the diff adds. Run `pnpm db:migrate` on an empty database at head, then `psql -c '\d session_entries'`. Save `migrate.png`. Pass when both tables and every index exist.
- [ ] Lane 2. Run the migration on a database that already holds threads and messages from a trunk seed. Save `migrate-existing.png`. Pass when the migration exits zero, every thread has a `sessionId`, and `messages` is untouched.
- [ ] Lane 3. Append 1 000 entries through `PostgresSessionLog` in a script and read the tail. Save `pg-tail.png`. Pass when the tail stops at the last compaction and is in seq order.
- [ ] Lane 4. Append from two processes at once against real Postgres for 10 seconds. Save `pg-concurrent.png`. Pass when no seq collides and every entry's parent is the previous seq.
- [ ] Lane 5. Rewind to an older entry through the log and read the tail. Save `pg-rewind.png`. Pass when entries after the target are absent from the tail and still present in the table.
- [ ] Lane 6. Create a child session from a parent entry, append to both at once, read both tails. Save `pg-child.png`. Pass when the chains never cross and the child row points at the parent entry.
- [ ] Lane 7. Run the same 1 000 entry script on `FileSessionLog`. Save `file-tail.png`. Pass when the tail matches the Postgres result entry for entry.
- [ ] Lane 8. Corrupt a newline-terminated line of a file log and read the tail, then truncate the file mid-line with no trailing newline and read again. Save `file-corrupt.png`. Pass when the first read reports the line and refuses the tail instead of returning a partial chain, and the second read skips the torn final line and returns the chain before it.
- [ ] Lane 9. Run `pnpm lint` and `pnpm check` at head. Save `lint-check.png`. Pass when both exit zero.
- [ ] Lane 10. Run `pnpm test` at head. Save `full-unit.png`. Pass when the run exits zero.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Trunk lacks the feature. The diff-added work is `readTail` on a 200 000 entry session with a compaction every 500 entries. Measure median wall time over five runs on real Postgres 16.
- [ ] Probe. The script from Appendix A ported to `PostgresSessionLog`, run at head against the compose Postgres.
- [ ] Baseline. The pglite figure from Appendix A, 3.5 ms, recorded as the reference.
- [ ] Rule. Absolute budget. Fail when the median exceeds 15 ms, or when the worst case without a compaction entry exceeds 500 ms.

**Review gate.** None. SL2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto the current feature branch after the verdict, patch-id unchanged.
- [ ] The root merges SL2 into `feature/session-log`.

## Write every message, run step and subagent to the log (SL3)

**Depends on.** SL2.

**Files.**

- [ ] Edit `packages/adapters/src/executor.ts`.
- [ ] Edit `packages/adapters/src/pi-runtime.ts`.
- [ ] Edit `packages/adapters/src/bot-messages.ts` and `packages/adapters/src/group-handoff.ts`.
- [ ] Edit `packages/db/src/messages.ts`.
- [ ] Edit `packages/db/src/events.ts`.
- [ ] Edit `apps/api/src/router.ts`.
- [ ] Edit `apps/api/src/app.ts` and `apps/worker/src/index.ts`.
- [ ] Edit `packages/adapters/src/executor.test.ts`, `packages/adapters/src/pi-runtime-tool-dispatch.test.ts`, `packages/adapters/src/bot-messages.test.ts` and `apps/api/src/router.test.ts`.

**Build.**

- [ ] `createThreadMessageInTransaction` in `messages.ts` also appends a `user.message` entry to the thread's main session with the same blocks, `clientNonce` and reply fields. Every writer of user messages (web and mobile send, steering, external mirrors, routines) therefore writes the entry through the one existing path.
- [ ] The executor appends `run.started` with its `RunTrigger`, model and effort before the first model call, one `assistant.text` or `assistant.reasoning` entry per finished block, `assistant.ask` or `assistant.choice` when the run pauses for input, one `tool.call` when a tool is invoked and one `tool.result` when it returns, and `run.finished` with usage and status in `finalizeRun`, including `cancelled` with `by`. Tool payloads keep the 4 000 character cap from `describeToolPayload` for now.
- [ ] `run_subagent` in `pi-runtime.ts` creates a child session and a child `Run` row with `parentRunId`, runs the helper in process as today, and writes the helper's own `run.started`, blocks, tool entries and `run.finished` to the child session. On completion the parent run appends one `subagent` entry with the child `sessionId`, name, model, task, status, result and usage. The parent session receives nothing else from the helper. Progress ticks go to the `events` feed.
- [ ] Approvals append `effect.requested`, `effect.edited` and `effect.resolved`. Takeover appends `computer.control` on grant and on release. Compaction's memory step appends `memory.revised`. Skill saving appends `skill.saved`.
- [ ] `handoffToGroupBot` in `group-handoff.ts` appends a `handoff` entry to the group session and starts the receiver's run with a `handoff` trigger pointing at it. `messageBot` in `bot-messages.ts` appends `bot.message.sent` to the sender's session and `bot.message.received` to the receiver's session in one transaction, with the delivery key as `clientNonce`, and starts the receiver's run with a `bot_message` trigger. `resolveRunHop` reads `hop` from the log instead of message blocks. Connected agents go through the same two entries with an `agent` peer.
- [ ] `clearThread` and `rewindThread` in `events.ts` append `clear` and `rewind` entries in the same transaction as today's row changes.
- [ ] Harness runtimes append `harness.session` when they learn a session id.
- [ ] `PostgresSessionLog` is wired in both composition roots and handed to the executor through `deps.sessionLog`.
- [ ] `Message` rows keep being written in this slice. The feature branch removes them in SL6.

**You see.**

- [ ] After one bot reply with a subagent, `select type, seq, parent_id from session_entries where session_id = <main> order by seq` shows `user.message, run.started, tool.call, subagent, assistant.text, run.finished` in a linear chain, and the child session holds the helper's own run.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `executor.test.ts` gains a case that runs the offline model emulator through one tool call and asserts the literal entry type sequence and parent chain, and a case with a cancelled run asserting `run.finished.status`. Run `pnpm --filter @rakazo/adapters test`.
- [ ] `pi-runtime-tool-dispatch.test.ts` gains a case where `run_subagent` runs through the emulator and asserts the child session's entries and the parent's single `subagent` entry. Run `pnpm --filter @rakazo/adapters test`.
- [ ] `router.test.ts` gains a case that sends a message with a reply and a client nonce and asserts the `user.message` entry payload. Run `pnpm --filter @rakazo/api test`.
- [ ] `bot-messages.test.ts` gains a case where bot A messages bot B and B answers with a result, asserting the four entries, their cross links and one `exchangeId`, and a case that redelivers the same delivery key and asserts no second `received` entry. Run `pnpm --filter @rakazo/adapters test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Send a message and get a reply at trunk and at head, then have bot A message bot B at trunk and at head. Save `reply-trunk.png`, `reply-head.png` and `bot-message-both.png`. Pass when the replies render the same on both, head adds the entry rows, and B's reply reaches A on both.
- [ ] Lane 2. Ask the bot to use a tool. Save `tool-entries.png`. Pass when `tool.call` and `tool.result` rows share a `callId`.
- [ ] Lane 3. Ask the bot for a task that makes it run a subagent. Save `subagent-rows.png`. Pass when the parent session holds exactly one `subagent` row for it and the child session holds the helper's run with its own `run.started` and `run.finished`.
- [ ] Lane 4. Rewind the thread from the UI, then clear it. Save `rewind-clear.png`. Pass when a `rewind` row points at the target and a `clear` row has a null parent.
- [ ] Lane 5. Send a steering message during a run. Save `steer-entry.png`. Pass when the `user.message` entry lands between two run entries in the chain and the next `run.started` trigger is `steering`.
- [ ] Lane 6. Fire a routine, then in a group have one bot hand off to another. Save `routine-handoff.png`. Pass when the routine run's trigger is `routine`, a `handoff` row exists in the group session, and the receiver's run trigger is `handoff` pointing at it.
- [ ] Lane 7. Trigger an approval and edit the proposal before approving. Save `effect-rows.png`. Pass when `effect.requested`, `effect.edited` and `effect.resolved` rows exist in order.
- [ ] Lane 8. Kill the worker mid-run and restart it. Save `crash-resume.png`. Pass when the entries written before the kill remain and `run.finished` records the final status.
- [ ] Lane 9. Run `pnpm lint` and `pnpm check` at head. Save `lint-check.png`. Pass when both exit zero.
- [ ] Lane 10. Run `pnpm test:e2e:affected` at head. Save `e2e-affected.png`. Pass when the run exits zero.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from send to first streamed token, at trunk and at head, over twenty messages against the offline emulator.
- [ ] Probe. The `perf:desktop` harness pointed at the web app, run interleaved trunk then head five times.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail when the head median exceeds the trunk median by more than 10 percent or by more than 20 ms, whichever is larger.

**Review gate.** None. SL3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto the current feature branch after the verdict, patch-id unchanged.
- [ ] The root merges SL3 into `feature/session-log`.

## Build the inference context from the log (SL4)

**Depends on.** SL3.

**Files.**

- [ ] Edit `packages/adapters/src/executor.ts`.
- [ ] Edit `packages/adapters/src/reply-context.ts`.
- [ ] Edit `packages/adapters/src/history-compaction.ts`.
- [ ] Edit `packages/adapters/src/background-job-handlers.ts`.
- [ ] Edit `packages/db/prisma/schema.prisma` and add a migration dropping `historyCompactedUpToSeq`, `historyCompactionSummary`, `historyCompactionGeneration`.
- [ ] Delete `packages/db/src/messages.ts` function `loadRunHistoryMessages`.
- [ ] Edit `packages/adapters/src/history-compaction.test.ts` and `executor.test.ts`.

**Build.**

- [ ] The executor loads history through `deps.sessionLog.readTail(sessionId)` and `projectInferenceTurns` from SL1, then applies `selectHistoryWindow` unchanged. `LEGACY_HISTORY_WINDOW_SIZE` and `selectCompactedHistory` are deleted.
- [ ] `messageToAgentHistoryTurn` and `messageToAgentHistoryParts` in `reply-context.ts` are deleted. Their rendering rules live in `projectInferenceTurns` from SL1, which this slice confirms against the executor tests.
- [ ] `compactHistory` reads its batch from the log, skips entries whose audience is UI only, appends the summary as a `compaction` entry at the head of the session with `coveredUpToSeq` equal to its parent's seq, so every chain entry before it is covered and nothing sits between the summary and the reader's stop, and no longer touches `Thread` columns. `shouldEnqueueCompaction` counts entries after the last compaction. The batch it summarizes is the uncompacted prefix of the chain, and the entries it leaves verbatim for the model are the ones after that prefix, which the summary names as recent context inside its text, not through the chain.
- [ ] The executor passes `resolveReplyTarget` to `projectInferenceTurns`, a lookup of an entry by id outside the chain, so a reply to an entry older than the compaction keeps its quote. A cancelled run's assistant stretches are already dropped by the projection, matching trunk, which writes no history row for a cancelled run.
- [ ] The adapter-kit history types alias `AgentHistoryTurn` and `AgentHistoryTurnPart` from contracts. The tool caps, the replay helpers, `formatCompactedSummary` and the private copies of `escapePromptData` in adapters and the api are deleted in favor of the core exports SL1 added.
- [ ] `learnDurableFacts` reads the same batch of entries and appends `memory.revised`.
- [ ] Channel and group runs filter entries by `botId` and channel the way `loadRunHistoryMessages` did.
- [ ] A subagent run loads nothing from any log. Its context is the task its parent handed it, as today.

**You see.**

- [ ] The `agent.run.context` log line reports `source=session_log`, the entry count read, and the compaction seq when one exists.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `executor.test.ts` gains a case where the session holds a compaction entry and asserts the literal history handed to the runtime starts with the summary block, and a case where a `subagent` entry replays as a tool result. Run `pnpm --filter @rakazo/adapters test`.
- [ ] `history-compaction.test.ts` gains a case that compacts a 120 entry session holding UI-only entries and asserts a `compaction` entry exists, the next tail is 20 entries plus the summary, and the summary prompt never saw the UI-only entries. Run `pnpm --filter @rakazo/adapters test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Hold a six turn conversation with a tool call at trunk and at head and dump the history the runtime receives. Save `history-trunk.png` and `history-head.png`. Pass when the turn arrays are equal apart from tool call ids.
- [ ] Lane 2. Drive a session past the compaction threshold and wait for the job. Save `compaction-entry.png`. Pass when a `compaction` row exists and the next run's context log names its seq.
- [ ] Lane 3. Rewind to before the compaction entry and send a message. Save `rewind-past-compaction.png`. Pass when the next run reads the full chain from the rewind target with no summary.
- [ ] Lane 4. Clear the thread and send a message. Save `clear-then-send.png`. Pass when the history handed to the runtime holds only the new message.
- [ ] Lane 5. Group thread with two bots and a handoff, then a direct bot message between two other bots. Save `group-history.png` and `direct-history.png`. Pass when each bot's history wraps the other's words in `<bot_message>`, the receiver of the direct message sees it as its waking user turn, and the sender sees what it sent on its own side.
- [ ] Lane 6. Channel thread mirrored from an external conversation. Save `channel-history.png`. Pass when only channel inputs and the bot's own output appear.
- [ ] Lane 7. A conversation with a subagent, then one more message. Save `subagent-replay.png`. Pass when the runtime history holds the subagent's result as a tool result and none of the child session's entries.
- [ ] Lane 8. Confirm the three `historyCompaction*` columns are gone with `psql -c '\d threads'`. Save `columns-gone.png`. Pass when none is listed.
- [ ] Lane 9. Run `pnpm lint` and `pnpm check` at head. Save `lint-check.png`. Pass when both exit zero.
- [ ] Lane 10. Run `pnpm test:e2e:affected` at head. Save `e2e-affected.png`. Pass when the run exits zero.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. History load time inside the executor, from the start of history loading to the runtime hand-off, logged in `agent.run.context`, on a session with 2 000 messages and one compaction, at trunk and at head.
- [ ] Probe. Seed the session with a script, send ten messages at trunk then ten at head, interleaved twice, read the log line.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail when the head median exceeds the trunk median. The tail read is bounded by the compaction entry while trunk reads 200 rows, so head must be at or under trunk.

**Review gate.** None. SL4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto the current feature branch after the verdict, patch-id unchanged.
- [ ] The root merges SL4 into `feature/session-log`.

## Serve the UI from the log (SL5)

**Depends on.** SL4.

**Files.**

- [ ] Edit `apps/api/src/router.ts`.
- [ ] Edit `packages/contracts/src/events.ts`, `packages/contracts/src/domain.ts` and `packages/contracts/src/rpc.ts`.
- [ ] Edit `apps/web/src/lib/thread-events.ts`, `apps/web/src/pages/Shell.tsx` and the thread components under `apps/web/src/components/`.
- [ ] Edit `apps/mobile/app/thread.tsx`, `apps/mobile/lib/api.ts` and the thread components under `apps/mobile/components/`.
- [ ] Edit `apps/web/e2e/` specs that exercise thread history, rewind, clear, approvals and the Activity tab.
- [ ] Edit `apps/web/src/lib/thread-events.test.ts`.

**Build.**

- [ ] `ThreadSnapshotSchema` and `ThreadMessagePageSchema` in `domain.ts` carry `items: ThreadItem[]` in place of `messages`. `threads.get` and `threads.messages` in `router.ts` read through `sessionLog.readPage` and `projectThreadItems`. The page size stays 100. `olderCursor` becomes the seq of the oldest entry in the page.
- [ ] `sessions.entries({ sessionId })` and `runs.entries({ runId })` join the RPC and return raw entries for the detail views. This slice ships the RPCs and the subagent card's click, which opens the child session as a read-only thread view. The full run detail screen is a later feature, Appendix D.
- [ ] `session.entry.appended` joins `ProductEventSchema`. `thread.message.created`, `thread.message.updated` and `thread.subagent` are no longer emitted.
- [ ] `reduceThreadSnapshot` folds `session.entry.appended` into the snapshot through `projectThreadItems` applied to the run's entries received so far, so a bot message grows block by block and the run card updates in place. A steering message mid-run splits the bot message into two items, as the projection does. Progress events keep driving the shimmer.
- [ ] Web renders each `ThreadItem.kind` with one component. `message` keeps today's bubble. `run` is a compact card with trigger, model and status that expands to usage and duration. `subagent` is a card with name, model, status and result that opens the child session. `handoff` is a line naming both bots. `botMessage` is a card with direction, peer, intent and a link to the linked entry in the peer's thread, muted when unanswered. `divider` is a hairline with a label for compaction and rewind. `effect` is the approval card already in the app. `note` is a centered line. Copy stays minimal per the repo rule and the PR quotes it.
- [ ] Mobile renders the same union with native list rows, through the shared core projection.
- [ ] The bot page's Activity tab reads `run` items from the same projection instead of its own recap query.
- [ ] Rewind and clear in the UI call the existing endpoints, which now append entries. The reducer handles `rewind` and `clear` entries by replacing the snapshot with a fresh `threads.get`.

**You see.**

- [ ] The thread renders as on trunk for plain messages, shows a run card above each bot reply, a subagent card where a helper ran, and the network tab shows `session.entry.appended` events instead of message updates.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `thread-events.test.ts` gains a case feeding the entries of one run with a subagent in order and asserting the literal snapshot after each event. Run `pnpm --filter @rakazo/web test`.
- [ ] The web e2e specs for history paging, rewind, clear, approvals and the Activity tab are updated and pass. Run `pnpm test:e2e:affected`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Open a seeded 300 message thread at trunk and at head. Save `thread-trunk.png` and `thread-head.png`. Pass when both render the same last twenty messages and head adds one run card per bot reply.
- [ ] Lane 2. Scroll up to load older pages three times. Save `paging.png`. Pass when 300 messages are present with no duplicate and no gap.
- [ ] Lane 3. Watch a reply stream with a tool call. Save `stream-steps.png`. Pass when the run card appears first, the step appears before the text, and the final items match a reload.
- [ ] Lane 4. Run a task that spawns a subagent, click its card. Save `subagent-card.png` and `subagent-session.png`. Pass when the card shows name, model and result, and the click opens the child session with the helper's own tool calls.
- [ ] Lane 5. Rewind from the UI, then clear. Save `ui-rewind-clear.png`. Pass when the cut items vanish, a divider marks the rewind, and a reload agrees.
- [ ] Lane 6. Same thread open in two browser tabs while one sends. Save `two-tabs.png`. Pass when both show the reply and the run card.
- [ ] Lane 7. Phone width 390 by 844 on the same thread. Save `phone.png`. Pass when the run and subagent cards fit the width with no horizontal scroll.
- [ ] Lane 8. Native iOS through `pnpm test:mobile-screenshots`. Save `ios.png`. Pass when the thread screen renders the seeded messages and a run card.
- [ ] Lane 9. Trigger an approval, edit it, approve it, fire a routine, and have bot A message bot B. Save `effect-routine-botmsg.png`. Pass when the effect card shows the edit, the routine's run card names the routine, A's thread shows the sent card linking to B's thread, and B's thread shows the received card and its run.
- [ ] Lane 10. Run `pnpm test:e2e:affected` at head. Save `e2e-affected.png`. Pass when the run exits zero.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `threads.get` response time on a 2 000 message thread, at trunk and at head, over fifty requests.
- [ ] Probe. A script calling the RPC in a loop, interleaved trunk then head five times.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail when the head median exceeds the trunk median by more than 10 percent.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 3, 4, 5 and 7 screenshots into `docs/screenshots/session-log/sl5-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a streamed reply with a subagent, a click into the child session, a rewind and a clear on a lane VM. Save it as `docs/screenshots/session-log/sl5-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto the current feature branch after the verdict, patch-id unchanged.
- [ ] The root merges SL5 into `feature/session-log` after the operator's review.

## Backfill existing threads and delete the message rows (SL6)

**Depends on.** SL5.

**Files.**

- [ ] Create `packages/db/src/backfill-session-log.ts` and `scripts/backfill-session-log.ts`.
- [ ] Edit `packages/db/prisma/schema.prisma` and add a migration that drops `messages`, `nextMessageSeq`, and repoints `Run.sourceMessageId`, `SteeringMessage.messageId`, `ExternalMessage.threadMessageId`, `Artifact` link preview relations to entry ids.
- [ ] Delete `packages/adapters/src/pi-session.ts` and its wiring in both composition roots.
- [ ] Delete the `subagent`, `steps`, `bot_message_sent` and `bot_message_received` members of `MessageBlock` in `packages/contracts/src/events.ts` once no reader remains.
- [ ] Create `scripts/session-log-export.ts` and `scripts/session-log-import.ts`.
- [ ] Edit `CHANGELOG.md`.
- [ ] Create `packages/db/src/backfill-session-log.test.ts`.

**Build.**

- [ ] `backfillThread(prisma, threadId)` converts `Message` rows in seq order into a linear chain in the thread's main session. A user row becomes `user.message`. A bot row becomes `run.started` with a `message` trigger, its steps as `tool.call` and `tool.result` pairs, a `subagent` block as a `subagent` entry with no `sessionId`, a `bot_message_sent` or `bot_message_received` block as the matching `bot.message.*` entry with the cross link resolved through the message id map when the peer thread is backfilled, its text as `assistant.text`, and `run.finished`. A thread with `historyCompactionSummary` from a database older than SL4 gets a `compaction` entry at the summarized seq. Idempotent, it skips a session whose entries already exist.
- [ ] The script runs the backfill for every thread before the drop migration, in batches, and logs progress per thread.
- [ ] Export streams a thread's main session and every child session as JSONL files through `encodeEntries`, one file per session. Import reads them through `decodeEntries` and appends to new sessions, rewriting the `subagent` entries' `sessionId` to the imported child.
- [ ] `PiJsonlSessionRecorder` and `PI_SESSION_RECORDING` are deleted. The log is the record.
- [ ] CHANGELOG under `## [Unreleased]`, dated for the feature PR's merge day, Added. "**A bot's conversation is now a complete, replayable history.** Each reply shows the run behind it, a helper the bot spawned opens in its own view, rewind and clear keep what came before, a long thread opens and resumes from its last summary on web, desktop and mobile, and a thread can be exported to or imported from JSONL files."

**You see.**

- [ ] On a database seeded from trunk, the script reports every thread backfilled, the drop migration applies, and every thread renders as before on web and mobile.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `backfill-session-log.test.ts` gains a case that backfills a thread holding a user message, a bot message with two steps and a subagent block, and a compaction summary, and asserts the literal entry sequence. A second case runs the backfill twice and asserts the entry count is unchanged. Run `pnpm --filter @rakazo/db test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Seed twenty threads at trunk, snapshot `threads.get` for each, backfill and migrate at head, snapshot again. Save `backfill-diff.png`. Pass when the message items are equal apart from ids and head adds run items only.
- [ ] Lane 2. Run the backfill twice. Save `backfill-idempotent.png`. Pass when the second run inserts nothing.
- [ ] Lane 3. Export a thread with a subagent, import it into a new thread, open it and click the subagent card. Save `export-import.png`. Pass when the new thread renders the same items and the card opens the imported child session.
- [ ] Lane 4. Confirm `messages` is dropped with `psql -c '\d messages'`. Save `messages-gone.png`. Pass when the relation does not exist.
- [ ] Lane 5. Open a thread whose run referenced a source message through `Run.sourceMessageId`. Save `run-source.png`. Pass when the run's card in the Activity tab still links to the message.
- [ ] Lane 6. Reply to an external Slack mirrored message after migration. Save `external-reply.png`. Pass when the reply threads correctly on the channel.
- [ ] Lane 7. Link preview artifact on a backfilled message. Save `link-preview.png`. Pass when the preview renders.
- [ ] Lane 8. Grep the tree for `pi-sessions`, `PI_SESSION_RECORDING`, `kind: "subagent"`, `kind: "steps"` and `bot_message_sent`. Save `legacy-gone.png`. Pass when no hit remains outside the changelog and the backfill.
- [ ] Lane 9. Run `pnpm lint`, `pnpm check` and `pnpm test` at head. Save `lint-check-test.png`. Pass when all exit zero.
- [ ] Lane 10. Run `pnpm test:e2e` in full at head, since the migration touches shared plumbing. Save `e2e-full.png`. Pass when the run exits zero.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Trunk lacks the feature. The diff-added work is the backfill. Measure wall time of the backfill over 100 threads of 500 messages each.
- [ ] Probe. The script with timing output, run three times on a fresh seed.
- [ ] Baseline. None on trunk. Record the head median as the first baseline.
- [ ] Rule. Absolute budget. Fail when the median exceeds 60 seconds for 50 000 messages.

**Review gate.** None. SL6 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto the current feature branch after the verdict, patch-id unchanged.
- [ ] The root merges SL6 into `feature/session-log`, marks the feature PR ready for review, and the operator lands it after bot review.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

**How to read a tree log's tail in Postgres.** Throwaway script in the session scratchpad, `proto-chain/bench.mjs`, on `@electric-sql/pglite` 0.4.3 from the lockfile. One session, 200 000 entries, a `compaction` every 500, a `rewind` of depth 40 every 5 000, payloads of 400 characters. Five runs each, median reported.

| Read | Median |
| --- | --- |
| A. Recursive CTE from the head up to the compaction entry, 500 rows | 3.5 ms |
| B. Seq range from a stored compaction pointer, chain filtered in memory | 2.9 ms |
| C. UI page of the 100 newest chain entries via a depth bounded CTE | 0.5 ms |
| D. Full chain walk with no compaction entry, 198 479 rows | 261 ms |

Decision. A. The head is the entry with the highest seq in its session, so the reader needs no pointer at all. B saves 0.6 ms against one more pointer to keep right on every rewind. D bounds the worst case before the first compaction. The plan query is the CTE in the script, indexed by the primary key and `(sessionId, seq)`.

**Unproven.** The same figures on real Postgres 16 under concurrent appenders, which SL2's perf box measures. The file backend's backwards read on a multi megabyte file, which SL1 lane 6 observes. The cost of writing a subagent's full transcript, which SL3's perf box bounds through time to first token.

## Appendix B. Alternatives rejected

- **One JSONL file per session as the production store, as Claude Code does.** Claude Code has one process and one writer per session. Rakazo has the API, the worker, steering, peer bots and channel mirrors writing one session, often from two processes. A shared file needs a single writer actor and a queue in front of it, which is more plumbing than a table that already serializes through the session row lock. The file backend stays for export, import, fixtures and a future single process self-host.
- **One JSONL file per run plus a thread index, generalizing `PiJsonlSessionRecorder`.** Reading a session's tail means opening the last N run files and stitching, and a run file has no place for user messages written between runs. The recorder is deleted in SL6 instead.
- **A linear log with `rewind` tombstones.** Simpler projection, but the operator wants a tree so a conversation can fork later. The tree costs one `parentId` column and a recursive CTE measured at 3.5 ms.
- **Reusing the `events` table as the log.** It carries ephemeral progress, run status, effects and usage that the transcript must not contain. Mixing them means every reader filters, and the event seq would double as the transcript seq. Two tables, two domains.
- **One entry per finalized message.** Fewer rows, but a crash mid-run loses the run's work and tool replay in inference has to reparse a `steps` block. Per block entries also make the streaming UI a fold over the same data it persists.
- **Subagent entries inside the parent session, flagged with an `agentId` lane as Claude Code's `isSidechain`.** Keeps one log per thread but breaks the head invariant, forces a lane filter on every append, and lets a chatty helper swell the parent's table. A child session with one `subagent` entry in the parent keeps the parent clean, which is the point of a subagent.
- **Generic `delegate.started` and `delegate.finished` entries for every bot to bot case.** They matched no tool in the code. Group handoff, direct `message_bot` and connected agents are three real paths with different payloads, so they get `handoff`, `bot.message.sent` and `bot.message.received`, and one rendering rule in the inference projection.
- **One entry type per trigger source (`routine.fired`, `webhook.received`, `retry.started`).** Three types that mean the same fact. One `run.started` with a `RunTrigger` sum type, and the UI switches on `kind`.
- **Keeping `ThreadMessage[]` as the wire shape and smuggling run cards as a `role`.** A message with a fake role is a branch in every renderer. A `ThreadItem` union is one decision in one place.
- **Materialized projections.** Nothing measured needs one. The perf boxes in SL2, SL4 and SL5 are the gate for adding one later.

## Appendix C. Risks

- **SL3, dual write window inside the feature branch.** Entries and `Message` rows both written until SL6. A writer added on `main` during the program that writes a `Message` without an entry is lost at backfill. The owner greps `message.create` on every rebase and adds the entry write.
- **SL3, subagent transcript volume.** A helper that loops on tools writes hundreds of entries into its child session, and child sessions are never compacted. Acceptable for the program. A purge of child sessions by age is a later feature, Appendix D, and the owner records the largest child session seen in the lanes.
- **SL4, history parity.** The inference projection must reproduce `messageToAgentHistoryTurn` byte for byte or bots change behavior silently. Lane 1 dumps both histories and diffs them. The owner keeps the trunk function in a test fixture until the lane passes. Two known divergences are accepted and recorded in SL1. Another bot's words are always wrapped in `<bot_message>`, group or not, and a steering message written mid-run now sits between the two stretches of the reply instead of before the whole reply, because the log keeps seq order.
- **SL5, scope.** Rendering a union on two surfaces is real UI work. The owner ships the six item kinds with minimal chrome and no new copy beyond the divider labels and the card fields, and quotes every visible word in the PR per the repo rule.
- **SL5, streaming regressions.** The UI fold replaces `thread.message.updated`. A block order bug shows as text before steps or a duplicated message. Lanes 3 and 6 watch it on two tabs.
- **SL6, foreign keys into `messages`.** `Run.sourceMessageId`, `SteeringMessage.messageId`, `ExternalMessage.threadMessageId` and link preview artifacts repoint to entry ids. The backfill records a message id to entry id map and the migration uses it. Lanes 5, 6 and 7 cover each.
- **SL6, irreversible drop.** The drop migration runs after the backfill in one deploy. The owner takes a `pg_dump` before the drop on any shared database and the plan never force pushes the feature branch.
- **All, mobile surface.** Lane 8 of SL5 drives the iOS simulator through `pnpm test:mobile-screenshots`. If the simulator is unavailable on the lane VM, the lane records that and the operator captures it before the review gate.

## Appendix D. Links, reading list and what comes after

- `docs/plans/2026-09-19-multi-harness.md`, section 2.5, for why harness sessions stay outside the log.
- `docs/plans/2026-09-19-harness-quality.md` for the compaction and history window history. The 200 row cap it lists as open closes in SL4.
- `docs/plans/2026-10-06-adaptive-effort.md` for the `EffortChoice` that `run.started` records.
- `packages/adapters/src/history-compaction.ts` and `packages/adapters/src/reply-context.ts` before SL1 and SL4.
- `packages/adapters/src/pi-runtime.ts` around `run_subagent`, `packages/adapters/src/bot-messages.ts` and `packages/adapters/src/group-handoff.ts` before SL3.
- `packages/db/src/events.ts` around `appendEventInTransaction` before SL2.
- `apps/web/src/lib/thread-events.ts` before SL5.
- `apps/web/e2e/README.md` before editing any spec.
- SL1 and SL4 get `.claude/skills/how/SKILL.md` on the executor history path and `.claude/skills/interrogate/SKILL.md` on the entry contract before code. The trail per `.claude/skills/show-me-your-work/SKILL.md` stays local per owner and is returned in each report.

**Planned after the program, not in it.** Each one needs only what the program already lays down.

- Run detail view. Click a run card, see its timeline of tool calls with input and output, reasoning, text, usage and duration. Needs `runs.entries` from SL5 and the `(runId, seq)` index from SL2. Reconsider the 4 000 character tool payload cap at that point, it decides how useful the view is.
- Session detail view as a first class screen, for child sessions and for a rewound branch, with a "rewound" badge on a run that is off the main chain.
- Purge of child sessions by age, and an archive export before purge.
- Conversation fork from any entry, a new session whose first entry's parent is the chosen entry.
- Exchange view between bots. One query on `exchangeId` across sessions shows a whole bot to bot conversation, however many bots it crossed. Needs only the `exchangeId` field SL1 defines and an index on it when the view ships.
- Inference context for `run.started` triggers and `computer.control`, today one context line, tunable through `ENTRY_AUDIENCE` without a schema change.

## Appendix E. Entry types and audience

| Type | Written by | Inference | UI |
| --- | --- | --- | --- |
| `user.message` | API, steering, routines, channel mirrors | yes | yes |
| `assistant.text` | Executor, per finished block | yes | yes |
| `assistant.reasoning` | Executor | no | yes |
| `assistant.ask`, `assistant.choice` | Executor, on pause for input | yes | yes |
| `tool.call`, `tool.result` | Executor | yes | yes |
| `subagent` | Parent run, once per helper | yes, as the tool result | yes, card to the child session |
| `handoff` | `handoffToGroupBot`, in the group session | yes, assistant for the sender, `<bot_message>` for the receiver | yes, line naming both bots |
| `bot.message.sent` | `messageBot`, in the sender's session | yes, assistant side | yes, card linking to the peer's thread |
| `bot.message.received` | `messageBot`, in the receiver's session | yes, the waking `<bot_message>` user turn | yes, card linking back |
| `run.started` | Executor | context | yes, run card |
| `run.finished` | Executor, `finalizeRun` | no | yes, run card |
| `effect.requested`, `effect.edited`, `effect.resolved` | Executor, approvals | no | yes |
| `computer.control` | Executor, takeover grant and release | context | yes |
| `memory.revised` | Compaction job | no | yes |
| `skill.saved` | Executor | no | yes |
| `attachment.added` | API | no | yes |
| `session.title` | API or executor | no | yes |
| `system.note` | API, channel joins | no | yes |
| `compaction` | Compaction job | yes, and reader stop | yes, divider |
| `rewind`, `clear` | API | no | yes, divider |
| `harness.session` | Harness runtime | no | no |

Kept out of the log, on purpose. `thread.progress`, `thread.meta`, `computer.status`, the three takeover negotiation events, `routine.created`, `routine.updated`, `bot.*`, `group.created`, `group.updated`, `skill.teaching.*`, `skill.draft.created`, `effect.recorded`, `effect.reconciled`, `usage.recorded`, `run.checkpointed`. Ephemeral, derivable, or facts about the bot and the group rather than the conversation.
