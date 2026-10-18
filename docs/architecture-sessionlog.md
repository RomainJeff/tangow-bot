# Session log architecture

Rakazo is one product on the web, the Electron desktop app and the Expo mobile app. The frontends express intent and render state, and the backend owns orchestration, as [AGENTS.md](../AGENTS.md) requires. The [architecture map](../ARCHITECTURE.md) links the other features' pages.

A conversation is an append-only log of typed entries. A person's message, each finished block of a bot's reply, each tool call and each tool result is one entry, one row in Postgres. An entry is never edited, and a rewind or a clear appends instead of deleting.

Two projections read the same entries, one for the turns the model reads and one for what a person sees, with the same code in `packages/core` on every surface.

No hosted vendor is required to run the core product, since models, sandboxes, memory and integrations sit behind optional provider-neutral ports.

This page describes the shape the [session log plan](plans/2026-10-10-thread-log.md) left. Threads from before it were backfilled into their sessions, and the `messages` table and the message events are gone.

## Messages are entries on a chain

Each entry is one fact, appended as the new head of its session, and its `parentId` names the head before it, apart from three exceptions.

Every entry has the envelope of `SessionEntrySchema` in [`session-log.ts`](../packages/contracts/src/session-log.ts): `id`, `sessionId`, `seq`, `parentId`, `ts`, a `botId` and a `runId` where the type has them, then `type` and a `payload` that the type shapes.

A run writes one entry per finished block of its reply and per tool call or result, and the thread folds them back into its messages.

The head of a session is its entry with the highest `seq`, and in Postgres the session row keeps `headEntryId` and `nextEntrySeq`. Every backend appends through `nextSessionEntry` in [`adapter-kit/src/session-log.ts`](../packages/adapter-kit/src/session-log.ts), which makes the head the parent, with three exceptions:

- A `rewind` names the entry the conversation goes back to, the one before the cut message.
- A `compaction` names the head its summary was built on, and the append fails with `stale_compaction` when the head has moved.
- A `clear` has no parent and starts a new chain, like the first entry of a session.

Chain reads follow `parentId` back from the head, so what a rewind cut stays in the table but leaves the chain. Readers that do not walk it, such as search and a link preview's target, test `ENTRY_ON_CHAIN`, and a bot's export reads the chain a page at a time. When a rewind cuts a compaction whose summary still holds, `appendRewindInTransaction` in [`sessions.ts`](../packages/db/src/sessions.ts) writes that compaction again on top of the rewind.

## Each entry type has an audience

An entry is admitted only when it is a durable fact of the conversation, something a person expects to see again a week later, and `ENTRY_AUDIENCE` in [`session-log.ts`](../packages/contracts/src/session-log.ts) says who reads each type.

In the Model column, `context` means one short line in the model's history. A Thread `yes` can still draw nothing.

| Type | Model | Thread | What it records |
| --- | --- | --- | --- |
| `user.message` | yes | yes | The person's words |
| `assistant.text` | yes | yes | One finished block of a reply |
| `assistant.reasoning` | no | yes | The model's reasoning |
| `assistant.ask`, `assistant.choice` | yes | yes | A question to the person |
| `tool.call`, `tool.result` | yes | yes | A tool call and its output |
| `bot.text` | yes | yes | A bot's words outside a run |
| `run.started` | context | yes | Trigger, model and effort |
| `run.finished` | no | yes | Outcome and usage |
| `run.opened` | no | no | Anchor for source-less interactive work |
| `run.recap` | context | no | Own-bot factual recap or missing-facts marker, with run and session references |
| `subagent` | yes | yes | A helper's result |
| `routine.started` | context | yes | A routine run opened its session |
| `routine.finished` | yes | yes | The routine's final words and outcome |
| `handoff` | yes | yes | A group bot passed the turn |
| `bot.message.sent`, `bot.message.received` | yes | yes | A message to or from another bot or agent |
| `effect.requested`, `effect.edited`, `effect.resolved` | no | yes | An approval, its edits and its decision |
| `effect.applied`, `card.answered`, `link.preview`, `link.preview.removed`, `skill.draft` | no | yes | A later state, by `target` |
| `computer.control` | context | yes | Who holds the computer |
| `memory.revised`, `skill.learnt` | no | yes | What the bot learned |
| `attachment.added`, `session.title`, `system.note` | no | yes | An attachment, a title, a note |
| `compaction` | yes | yes | A summary of older turns |
| `rewind`, `clear` | no | yes | A cut of the chain |
| `harness.session` | no | no | A harness's session id |

In a top-level bot's own conversation, its closing free text is not logged, since only what it sends with `message_user` reaches the person. A routine run, a helper, a sub-bot and a delegated run have their final reply as their output, and it is logged.

Nothing writes `attachment.added`, `session.title` or `harness.session` yet. Streamed text deltas (`thread.progress`), computer status, the takeover negotiation, per-call usage records and a bot's or a group's settings and members stay out of the log, in the `events` table or their own tables.

## Child sessions keep their own trace

A thread owns one main session. Interactive runs, routine runs, and helpers keep execution traces in child sessions. Public `message_user` replies, questions, approvals, and card state rise to the main session.

A session's `kind` is `thread`, `interactive`, `subagent`, or `routine`. A thread points at its main session through `threads.sessionId`. A child points at its parent session. An interactive session requires `parentEntryId`, the source entry or a `run.opened` anchor for source-less work. A subagent requires its launching `tool.call`. Child sessions have no thread.

`openRunLog` opens an interactive child and persists `run.sessionId` with `run.started` in one transaction. Recovery reuses that child. Terminal finalization writes `run.finished` in the child and `run.recap` in the parent. Messaging and channel-source follow-ups retain their main session. See [Interactive run memory](interactive-run-memory.md).

In Postgres, `routeOf` in [`sessions.ts`](../packages/db/src/sessions.ts) decides where an entry lands. A child session at any depth keeps its run's trace, the `RUN_TRACE_TYPES`: `run.*`, `assistant.text`, `assistant.reasoning`, `tool.*` and `subagent`. An `assistant.text` addressed to the person, or containing a card they must act on, rises to the main session instead. Anything else, such as an ask, an approval, the person's answer or a learned skill, goes to the top-most ancestor with a thread. The store sets `originSessionId` on the types that carry it, the child the entry came from, so the thread names the routine or helper and links to it. The split keeps a child's tool calls out of the person's next question.

A routine run opens its own session in `openRoutineSessionInTransaction`. The main session gets `routine.started` at launch and `routine.finished` at the end, with the final words, the status and the usage. The thread folds both into one card that opens the routine session.

A helper starts from the parent run's `run_subagent` call, in `startSubagent` in [`executor.ts`](../packages/adapters/src/executor.ts). It gets a child session and a `Run` row with `parentRunId`. When it ends, the parent session gets one `subagent` entry with the result, which answers the call.

A child session reads joined. `readRun` returns a run's entries from every session it wrote to, with the person's answers to its asks and the later state of its cards, in time order. `sessions.entries` reads a child session this way, so a routine's session shows the ask it raised and its answer among its own steps.

## Two projections read the same entries

The model and the person read the same entries through pure functions in `packages/core`, where `projectInferenceTurns` builds the model's turns and `projectThreadView` builds the thread's rows.

Both fold entries with `foldRuns` in [`run-fold.ts`](../packages/core/src/session-log/run-fold.ts), which turns a run's `assistant.*` and `tool.*` entries into one message per stretch. Any other entry closes the stretch, except `subagent` and the card-state entries. The thread also closes it at a `run_subagent` call, so the helper's card sits inside the reply. `toolAnswers` pairs each `tool.result` or `subagent` entry with the latest unanswered call of the same run and call id, since providers reuse ids.

**Inference.** [`project-inference.ts`](../packages/core/src/session-log/project-inference.ts) keeps the types whose audience is `yes` or `context`. Interactive history keeps the safe parent conversation and the current run's child context. Finished child traces do not replay. Completed legacy mainline traces become compact references while preserving public replies and raised cards. An own-bot `run.recap` renders escaped factual data with run ID, session ID, and status, or an explicit missing-facts reason. Another bot's recap facts never become peer text. Private reasoning is excluded.

Unanswered tool calls do not replay. Active answered tools remain available for resume. Only the leading compaction becomes a turn. A `subagent` entry adds no turn because its result answers `run_subagent`. Routine start and finish projection and channel history keep their existing behavior.

**Thread.** `projectThreadView` in [`project-thread-view.ts`](../packages/core/src/session-log/project-thread-view.ts) is the one projection web and mobile call. It cuts what a rewind or clear removed, projects items with [`project-ui.ts`](../packages/core/src/session-log/project-ui.ts), adds the live layer, then folds reactions, groups, routine runs and time markers. A `ThreadItem` is a `message`, `run`, `subagent`, `routine`, `handoff`, `botMessage`, `divider`, `effect` or `note`. A `run` item draws nothing.

Clients receive entries, never items. A card's later state is a new entry that names the card, by `target` for the card-state types or by `effectId` for an approval, because `parentId` stays the link to the head. No entry changes after it is written, so a client only merges new entries, and a reload and a second tab agree. Everything the thread shows is an entry, with three exceptions that stay outside the log on purpose:

- Streamed text, the `thread.progress` layer under the shimmer, which the run's next entry clears.
- Facts about the bot, the group and the queue, such as members, computer status and active runs, read from their tables.
- The takeover negotiation, though a grant or a release appends `computer.control`.

## Compaction bounds what a run reads

A run's history read, `readTail`, walks `parentId` back from the head, and the newest compaction on the chain stops it at the last `seq` its summary covers, `coveredUpToSeq`.

A thread's run reads that tail. A routine run reads no history, and a run that answers a channel post reads that channel's recent entries. The tail is the compaction, the kept window after `coveredUpToSeq`, and everything since, with the compaction first so the summary comes before the older entries it kept. Before the first compaction, the tail is the whole chain. A walk also stops at an entry with no parent. Thread pages walk past compactions. Here the compaction at 53 covers up to 40.

```text
seq    0 ... 40     41 ... 52     53           54 ... 60
       summarized   kept window   compaction   since
read   53, 41 ... 52, 54 ... 60
```

For interactive history, B is the smaller of 60,000 estimated tokens and the model window after fixed context, active context, and reply reserve. The reserve is at least 16,384 tokens and covers a larger actual output cap, resolved through the same helper Pi uses. There is no recent-history floor. The executor rejects a known window that cannot fit the fixed prompt and active work with that reserve. Unknown windows limit finished history by both 200 turns and the 60,000-token estimate, without guaranteeing full prompt capacity.

The executor separates active work before selecting finished history. A large old trace cannot force a fresh request to fail. After a completed run, compaction starts when uncompacted turns exceed B/2 tokens. The job keeps the newest exchanges within B/4 tokens, at least one, and summarizes the rest. Without a known window, the trigger is 20,000 tokens and the kept window is 10,000. Messaging and channel-source follow-ups retain their original budget and replay policy. A group or runtime without compaction reads at most 200 parent entries before projection.

The `search_runs` catalog discovers retained authorized IDs by originating prompt and stored factual recap even after compaction removes those IDs from the tail. A run-ID query searches bounded child results and raised parent replies. Authorization requires an active source or launch anchor and rechecks rewind and clear reachability. Source-message and peer bodies are excluded.

The job appends on the head it read. If the session moved on, the append fails, and the job retries once when only new entries landed or drops its work. The budget is in [`history-compaction.ts`](../packages/adapters/src/history-compaction.ts) and the walk in [`postgres.ts`](../packages/adapters/src/session-log/postgres.ts).

## Bots talk through three entry types

Three entry types carry what bots say to each other. For the model, another bot's words are a `<bot_message>` user turn, and a bot's own words stay on its assistant side.

- `handoff` records a group bot that passes the turn, in the group thread's session. `handoffToGroupBot` in [`group-handoff.ts`](../packages/adapters/src/group-handoff.ts) writes it.
- `bot.message.sent` lands in the sender's session and `bot.message.received` in the receiver's. `appendBotMessageInTransaction` in [`bot-messages.ts`](../packages/adapters/src/bot-messages.ts) writes both in one transaction, for `message_bot`, the automatic return of a result and connected agents.

A `bot.message.*` entry carries an `exchangeId`, the id of the first `bot.message.sent` of its exchange. A chain stops at six bot-started deliveries, counted in `hop`, apart from the automatic return of a result.

A `bot_message` run is a hidden peer run in two cases. A peer asked or told its bot something, with intent `request`, `question` or `fyi`, and the run does not answer a request or question its bot sent. Or its bot is a sub-bot. Of such a run, the server keeps only the asks, choices, approval cards, card states, bot messages and `message_user` words, through `visibleEntries` in [`project-thread-view.ts`](../packages/core/src/session-log/project-thread-view.ts).

## The feed carries appended entries

The `events` table stays the feed, and each transaction that appends entries to a thread emits one `session.entry.appended` event that carries all of them.

`appendSessionEntryInTransaction` in [`sessions.ts`](../packages/db/src/sessions.ts) inserts the event with the first entry, and later appends in the transaction add to it, so the feed holds each entry once. A child session's own trace has no feed, but what it raises does.

`threads.get` reads its snapshot under the thread's share lock in [`thread-target.ts`](../apps/api/src/thread-target.ts). It returns the newest 200 chain entries, `olderCursor`, the event cursor, the runs, and the members or the computer status. It adds the open runs' `thread.progress` events newer than their last entry, so a reload keeps the live text. `threads.messages` pages back from `olderCursor` or around an entry, in [`thread-message-pages.ts`](../apps/api/src/thread-message-pages.ts). Entries on pages and on the feed leave out `sessionId`, and the server filters hidden peer runs unless a peer view sets `includePeerRuns`.

Web, in [`thread-events.ts`](../apps/web/src/lib/thread-events.ts), and mobile, in [`api.ts`](../apps/mobile/lib/api.ts), share one reducer rule through `applyEntryEvent`. On `session.entry.appended`, merge the entries by id in `seq` order, then project. A rewind or clear needs no refetch, because the projection cuts the chain.

## Postgres stores the log

Postgres holds the log in the `sessions` and `session_entries` tables, and JSONL is the line format of the file backend and the test fixtures.

In [`schema.prisma`](../packages/db/prisma/schema.prisma), `sessions` owns identity, parentage and the head. `session_entries` keeps the envelope as columns and everything else in the `payload` jsonb. A field earns a column only when a query filters, sorts, joins or locks on it, and `clientNonce` and `originSessionId` stay in the payload under expression indexes instead.

Every append locks the thread, then the session row, so appends to a session serialize without a deadlock.

The port is `SessionLog<Tx>` in [`interfaces.ts`](../packages/adapter-kit/src/interfaces.ts), with `createSession`, `append`, `readTail`, `readPage`, `readAround`, `readRun`, `readEntry`, and `searchRun`. It has two backends:

- `PostgresSessionLog` in [`postgres.ts`](../packages/adapters/src/session-log/postgres.ts), which the API and the worker use.
- `FileSessionLog` in [`file.ts`](../packages/adapters/src/session-log/file.ts), one JSONL file per session through [`jsonl.ts`](../packages/core/src/session-log/jsonl.ts). It is meant for a single process install, and today only its tests use it.

[`conformance.ts`](../packages/adapters/src/session-log/conformance.ts) runs the same cases on both backends offline, Postgres on in-memory PGlite.

Export and import use the same line format. `exportThreadSessions` in [`session-files.ts`](../packages/db/src/session-files.ts) writes a thread's main session and every session under it, one file each, and `importThreadSessions` reads them into a thread whose session is empty, with new ids for every entry, session and run, a row for each run, and a refusal for any file the main session does not reach. [`session-log-export.ts`](../scripts/session-log-export.ts) and [`session-log-import.ts`](../scripts/session-log-import.ts) run them.

Once a harness runtime exists, its sessions, such as those of the Claude Code CLI or OpenCode, stay in the harness's own store, and the log records only a `harness.session` entry with the id.

## Threads from before the log were backfilled

`backfillThread` in [`backfill-session-log.ts`](../packages/db/src/backfill-session-log.ts) wrote a thread's `messages` rows, in order, as one chain in its main session. A person's message became a `user.message`, a bot's message the entries of its run between `run.started` and `run.finished`, its steps `tool.call` and `tool.result` pairs, a helper card a `subagent` entry with no session, and a routine card a `routine.started` and a `routine.finished` around a routine session whose run kept its trace there and raised the rest, as a live routine does. A preview, an answer, a draft and a skill line became their card states, and a compaction summary a `compaction`. A delivery from another bot links the `bot.message.sent` it came from when the sender's thread was already in the log, and no entry otherwise. Each message's id stayed on one of its entries, the first that shows it, so `Run.sourceMessageId`, `SteeringMessage.messageId`, `ExternalMessage.threadMessageId` and `Artifact.previewMessageId` name entries. A session that already held entries took the messages newer than its head at its end and refused older ones, which `--rebuild-from-messages` rebuilt from the messages in a fresh session.

Migration `20261012000000_drop_messages` defines `drop_messages_when_logged()`, which locks the table and drops it only once every message has an entry of its own id, and calls it, so the migration never fails. `moveMessagesToLog` backfills every thread and calls that function in one transaction that holds the table's lock throughout: a thread it refuses or fails to convert rolls the whole round back, and the round reports every such thread at once. [`backfill-session-log.ts`](../scripts/backfill-session-log.ts), which the one-shot `migrate` service in every Compose file runs before the API and the worker, runs the migrations and then the round, and the API runs the round at start, so a deployment on a Compose file without `migrate` still moves its messages within the limits [self-hosting](self-host.md#session-log-migration) gives, and its API exits naming the threads when the round is refused.

## Principles behind the shape

- A field earns a column only when a query needs it. A new entry type needs a payload schema, an audience row and projection cases, never a migration.
- An entry is admitted only when a person expects to see it again.
- A state change is a new entry that names its card, never a rewrite, so clients only merge.
- Frontends render state from the same projection on every surface, as [AGENTS.md](../AGENTS.md) requires.
- A new provider sits behind a port and passes an offline conformance test, here [`conformance.ts`](../packages/adapters/src/session-log/conformance.ts).

Later work is listed in Appendix D of the [session log plan](plans/2026-10-10-thread-log.md).
