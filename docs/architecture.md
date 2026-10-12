# Architecture

Rakazo is one product on the web, the Electron desktop app and the Expo mobile app, and Electron hosts the web app. The frontends express intent and render state, and the backend, the API and the worker, owns orchestration, validation, retries and provider translation, as [AGENTS.md](../AGENTS.md) requires.

A conversation is an append-only log of typed entries. A person's message, each finished block of a bot's reply, each tool call and each tool result is one entry, one row in Postgres. An entry is never edited, and a rewind or a clear appends instead of deleting.

Two projections read the same entries, one for the turns the model reads and one for what a person sees, with the same code in `packages/core` on every surface.

No hosted vendor is required to run the core product, since models, sandboxes, memory and integrations sit behind optional provider-neutral ports.

This page describes the shape after SL6, the last slice of the [session log plan](plans/2026-10-10-thread-log.md) to land, which backfills older threads and removes the legacy `messages` rows and events that writers still fill until then.

## Messages are entries on a chain

Each entry is one fact, appended as the new head of its session, and its `parentId` links it to the head before it.

Every entry has the envelope of `SessionEntrySchema` in [`session-log.ts`](../packages/contracts/src/session-log.ts): `id`, `sessionId`, `seq`, `parentId`, `ts`, a `botId` and a `runId` where the type has them, then `type` and a `payload` that the type shapes.

A run writes one entry per finished block of its reply and per tool call or result, and the thread folds them back into its messages.

The head of a session is its entry with the highest `seq`, and the session row keeps `headEntryId` and `nextEntrySeq`. Every backend appends through `nextSessionEntry` in [`adapter-kit/src/session-log.ts`](../packages/adapter-kit/src/session-log.ts), which makes the head the parent, with three exceptions:

- A `rewind` names the entry the conversation goes back to, the one before the cut message.
- A `compaction` names the head its summary was built on, and the append fails with `stale_compaction` when the head has moved.
- A `clear` has no parent and starts a new chain, like the first entry of a session.

Chain reads follow `parentId` back from the head, so what a rewind cut stays in the table but leaves the chain. A rewind of the first message writes a `clear` instead. When a rewind cuts a compaction whose summary still holds, `appendRewindInTransaction` in [`sessions.ts`](../packages/db/src/sessions.ts) writes that compaction again on top of the rewind.

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

Nothing writes `attachment.added`, `session.title` or `harness.session` yet. Streamed text deltas (`thread.progress`), computer status, the takeover negotiation, per-call usage records and changes to a bot or a group stay out of the log, in the `events` table or their own tables.

## Child sessions keep their own trace

A thread owns one main session, a routine run or a helper runs in a child session that keeps its trace, and what the person must answer or act on rises to the main session.

A session's `kind` is `thread`, `subagent` or `routine`. A thread points at its main session through `threads.sessionId`. A child session points at its parent session, and a subagent session also at `parentEntryId`, the `tool.call` that launched it. Neither child kind has a thread.

In Postgres, `routeOf` in [`sessions.ts`](../packages/db/src/sessions.ts) decides where an entry lands. A child session at any depth keeps its run's trace, the `RUN_TRACE_TYPES`: `run.*`, `assistant.text`, `assistant.reasoning`, `tool.*` and `subagent`. An `assistant.text` that holds an MCP approval is not trace. Anything else, such as an ask, an approval, the person's answer or a learned skill, goes to the top-most ancestor with a thread. The store sets `originSessionId` on the types that carry it, the child the entry came from, so the thread names the routine or helper and links to it. The split keeps a child's tool calls out of the person's next question.

A routine run opens its own session in `openRoutineSessionInTransaction`. The main session gets `routine.started` at launch and `routine.finished` at the end, with the final words, the status and the usage. The thread folds both into one card that opens the routine session.

A helper starts from the parent run's `run_subagent` call, in `startSubagent` in [`executor.ts`](../packages/adapters/src/executor.ts). It gets a child session and a `Run` row with `parentRunId`. When it ends, the parent session gets one `subagent` entry with the result, which answers the call.

A child session reads joined. `readRun` returns a run's entries from every session it wrote to, with the person's answers to its asks and the later state of its cards, in time order. `sessions.entries` reads a child session this way, so a routine's session shows the ask it raised and its answer among its own steps.

## Two projections read the same entries

The model and the person read the same entries through pure functions in `packages/core`, where `projectInferenceTurns` builds the model's turns and `projectThreadView` builds the thread's rows.

Both fold entries with `foldRuns` in [`run-fold.ts`](../packages/core/src/session-log/run-fold.ts), which turns a run's `assistant.*` and `tool.*` entries into one message per stretch. Any other entry closes the stretch, except `subagent` and the card-state entries. The thread also closes it at a `run_subagent` call, so the helper's card sits inside the reply. `toolAnswers` pairs each `tool.result` or `subagent` entry with the latest unanswered call of the same run and call id, since providers reuse ids.

**Inference.** [`project-inference.ts`](../packages/core/src/session-log/project-inference.ts) keeps the types whose audience is `yes` or `context`. It drops a tool call with no answer, and a cancelled run replays only its answered calls. Only the leading compaction becomes a turn. A `subagent` entry adds no turn, because its `result` replays as the output of the `run_subagent` call. `routine.started` is a context line. `routine.finished` replays the final words as words of the bot that ran it, or a context line when the routine failed or was cancelled without any.

**Thread.** [`project-thread-view.ts`](../packages/core/src/session-log/project-thread-view.ts) is the one function web and mobile call. It cuts what a rewind or clear removed, projects items with [`project-ui.ts`](../packages/core/src/session-log/project-ui.ts), adds the live layer, then folds reactions, groups, routine runs and time markers. A `ThreadItem` is a `message`, `run`, `subagent`, `routine`, `handoff`, `botMessage`, `divider`, `effect` or `note`. A `run` item draws nothing, since its reply is its bubbles and its steps.

Clients receive entries, never items. A card's later state is a new entry that names the card, by `target` for the card-state types or by `effectId` for an approval, because `parentId` stays the link to the head. No entry changes after it is written, so a client only merges new entries, and a reload and a second tab agree. Everything the thread shows is an entry, with three exceptions that stay outside the log on purpose:

- Streamed text, the `thread.progress` layer under the shimmer, which the run's next entry clears.
- Facts about the bot, the group and the queue, such as members, computer status and active runs, read from their tables.
- The takeover negotiation, though a grant or a release appends `computer.control`.

## Compaction bounds what a run reads

A run's history read, `readTail`, walks `parentId` back from the head, and the newest compaction on the chain stops it at the last `seq` its summary covers, `coveredUpToSeq`.

A thread's run reads that tail, while a routine run reads no history. The tail is the compaction, the kept window after `coveredUpToSeq`, and everything since, with the compaction first so the summary comes before the older entries it kept. Before the first compaction, the tail is the whole chain. A walk also stops at an entry with no parent. Thread pages walk past compactions. Here the compaction at 53 covers up to 40.

```text
seq    0 ... 40     41 ... 52     53           54 ... 60
       summarized   kept window   compaction   since
read   53, 41 ... 52, 54 ... 60
```

B is the history budget, the model's context window less a 16 384 token reply reserve and the rest of the request, never under 20 000 tokens. After a completed run, the executor enqueues a compaction once the turns after the last summary pass B/2 tokens. The job keeps the newest exchanges within B/4 tokens, at least one, and summarizes the rest. Without a known context window, the trigger is 20 000 tokens and the kept window 10 000. A thread with no owning bot, such as a group, or one on a runtime that cannot compact, reads the newest 200 entries.

The job appends on the head it read. If the session moved on, the append fails, and the job retries once when only new entries landed or drops its work. The budget is in [`history-compaction.ts`](../packages/adapters/src/history-compaction.ts) and the walk in [`postgres.ts`](../packages/adapters/src/session-log/postgres.ts).

## Bots talk through three entry types

Three entry types carry what bots say to each other. For the model, another bot's words are a `<bot_message>` user turn, and a bot's own words stay on its assistant side.

- `handoff` records a group bot that passes the turn, in the group thread's session. `handoffToGroupBot` in [`group-handoff.ts`](../packages/adapters/src/group-handoff.ts) writes it, and the next bot's `run.started` names it as its `handoff` trigger.
- `bot.message.sent` lands in the sender's session and `bot.message.received` in the receiver's. `appendBotMessageInTransaction` in [`bot-messages.ts`](../packages/adapters/src/bot-messages.ts) writes both in one transaction, for `message_bot`, the automatic return of a result and connected agents. The receiver's run names the received entry as its `bot_message` trigger.

A `bot.message.*` entry carries an `exchangeId`, the id of the first `bot.message.sent` of its exchange. A chain stops at six bot-started deliveries, counted in `hop`, apart from the automatic return of a result.

A `bot_message` run is a hidden peer run when a peer asked or told its bot something, with intent `request`, `question` or `fyi`, or when its bot is a sub-bot. Of such a run, the server keeps only the asks, choices, approval cards, card states, bot messages and `message_user` words, through `visibleEntries` in [`project-thread-view.ts`](../packages/core/src/session-log/project-thread-view.ts).

## The feed carries appended entries

The `events` table stays the feed, and each transaction that appends entries to a thread emits one `session.entry.appended` event that carries all of them.

`appendSessionEntryInTransaction` in [`sessions.ts`](../packages/db/src/sessions.ts) inserts the event with the first entry, and later appends in the transaction add to it, so the feed holds each entry once. A child session's own trace has no feed, but what it raises does.

`threads.get` reads its snapshot under the thread's share lock in [`thread-target.ts`](../apps/api/src/thread-target.ts). It returns the newest 200 chain entries, `olderCursor`, the event cursor, the runs, and the members or the computer status. It adds the open runs' `thread.progress` events newer than their last entry, so a reload keeps the live text. `threads.messages` pages back from `olderCursor` or around an entry, in [`thread-message-pages.ts`](../apps/api/src/thread-message-pages.ts). Entries on pages and on the feed leave out `sessionId`, and the server filters hidden peer runs unless a peer view sets `includePeerRuns`.

Web, in [`thread-events.ts`](../apps/web/src/lib/thread-events.ts), and mobile, in [`api.ts`](../apps/mobile/lib/api.ts), share one reducer rule through `applyEntryEvent`. On `session.entry.appended`, merge the entries by id in `seq` order, then project. A rewind or clear needs no refetch, because the projection cuts the chain.

## Postgres stores the log

Postgres holds the log in the `sessions` and `session_entries` tables, and JSONL is the line format at the edges.

In [`schema.prisma`](../packages/db/prisma/schema.prisma), `sessions` owns identity, parentage and the head. `session_entries` keeps the envelope as columns and everything else in the `payload` jsonb. A field earns a column only when a query filters, sorts, joins or locks on it, and `clientNonce` and `originSessionId` are queried through expression indexes on the payload instead.

Every append locks the thread, then the session row, so appends to a session serialize without a deadlock.

The port is `SessionLog<Tx>` in [`interfaces.ts`](../packages/adapter-kit/src/interfaces.ts), with `createSession`, `append`, `readTail`, `readPage`, `readAround`, `readRun` and `readEntry`. It has two backends:

- `PostgresSessionLog` in [`postgres.ts`](../packages/adapters/src/session-log/postgres.ts), which the API and the worker use.
- `FileSessionLog` in [`file.ts`](../packages/adapters/src/session-log/file.ts), one JSONL file per session through [`jsonl.ts`](../packages/core/src/session-log/jsonl.ts). It is meant for export, import and a single process install, and today only its tests use it.

[`conformance.ts`](../packages/adapters/src/session-log/conformance.ts) runs the same cases on both backends offline, Postgres on in-memory PGlite.

Harness sessions, such as those of the Claude Code CLI or OpenCode, stay in the harness's own store. The log would record only a `harness.session` entry with the id.

## Principles behind the shape

- A field earns a column only when a query needs it. A new entry type needs a payload schema, an audience row and projection cases, never a migration.
- An entry is admitted only when a person expects to see it again.
- A state change is a new entry that names its card, never a rewrite, so clients only merge.
- Frontends render state from the same projection on every surface, as [AGENTS.md](../AGENTS.md) requires.
- A new provider sits behind a port and passes an offline conformance test, here [`conformance.ts`](../packages/adapters/src/session-log/conformance.ts).

Later work is listed in Appendix D of the [session log plan](plans/2026-10-10-thread-log.md).
