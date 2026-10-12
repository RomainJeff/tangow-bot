# Architecture

Rakazo is one product on the web, the Electron desktop app and the Expo mobile app, and Electron hosts the web app. The frontends express intent and render state. The backend, the API and the worker, owns orchestration, authorization, validation, retries and provider translation, as [AGENTS.md](../AGENTS.md) requires.

A conversation is an append-only log of typed entries. A person's message, each block of a bot's reply, each tool call and its result, and the answer to a card are each one entry, one row in Postgres. An entry is never edited, and a rewind or a clear appends instead of deleting.

Two projections read the same entries. The inference projection builds the turns the model reads. The thread projection builds what a person sees, with the same code in `packages/core` on every surface.

Nothing a hosted vendor requires sits in the core. Models, sandboxes, memory and integrations are optional and sit behind provider-neutral ports with offline conformance tests.

This page describes the shape after SL6, the last slice of the [session log plan](plans/2026-10-10-thread-log.md), which backfills older threads into the log and removes the legacy `messages` rows that writers still fill next to the log until then.

## Messages are entries on a chain

Each entry is one fact, appended as the new head of its session, and its `parentId` links it to the entry before it.

Every entry has the envelope of `SessionEntrySchema` in [`session-log.ts`](../packages/contracts/src/session-log.ts): `id`, `sessionId`, `seq`, `parentId`, `ts`, an optional `botId` and `runId`, then `type` and a `payload` that the type shapes. `seq` counts up from 0 inside a session.

A run writes one entry per block, such as a finished text block, a question to the person, a tool call or its result, and the thread folds them back into one message.

The head of a session is its entry with the highest `seq`. The writer keeps `headEntryId` and `nextEntrySeq` on the session row and updates both in the statement that inserts the entry. Every backend appends through `nextSessionEntry` in [`session-log.ts`](../packages/adapter-kit/src/session-log.ts), which makes the head the parent, with three exceptions:

- A `rewind` names the entry the conversation goes back to, the one before the cut message.
- A `compaction` names the head its summary was built on, and the append fails with `stale_compaction` when the head has moved.
- A `clear` has no parent and starts a new chain, like the first entry of a session.

A reader follows `parentId` back from the head, so what a rewind cut stays in the table but leaves the chain. When a rewind cuts a compaction whose summary still holds, `appendRewindInTransaction` in [`sessions.ts`](../packages/db/src/sessions.ts) writes that compaction again on top of the rewind.

A `user.message` or `bot.message.received` with a `clientNonce` is written once, and a redelivery returns the existing entry.

## Each entry type has an audience

An entry is admitted only when it is a durable fact of the conversation, something a person expects to see again a week later, and `ENTRY_AUDIENCE` in [`session-log.ts`](../packages/contracts/src/session-log.ts) says who reads each type.

In the Model column, `context` means one short line in the model's history.

| Type | What it records | Model | Thread |
| --- | --- | --- | --- |
| `user.message` | The person's words | yes | yes |
| `assistant.text` | One finished block of a reply | yes | yes |
| `assistant.reasoning` | The model's reasoning | no | yes |
| `assistant.ask`, `assistant.choice` | A question to the person | yes | yes |
| `tool.call`, `tool.result` | A tool call and its output | yes | yes |
| `bot.text` | A bot's words outside a run | yes | yes |
| `run.started` | Trigger, model and effort | context | yes |
| `run.finished` | Outcome and usage | no | yes |
| `subagent` | A helper's result | yes | yes |
| `routine.started` | A routine run opened its session | context | yes |
| `routine.finished` | The routine's final words | yes | yes |
| `handoff` | A group bot passed the turn | yes | yes |
| `bot.message.sent`, `bot.message.received` | A message between bots | yes | yes |
| `effect.requested`, `effect.edited`, `effect.resolved` | An approval and its decision | no | yes |
| `effect.applied`, `card.answered`, `link.preview`, `link.preview.removed`, `skill.draft` | A later state, by `target` | no | yes |
| `computer.control` | Who holds the computer | context | yes |
| `memory.revised`, `skill.learnt` | What the bot learned | no | yes |
| `attachment.added`, `session.title`, `system.note` | An attachment, a title, a note | no | yes |
| `compaction` | A summary of older turns | yes | yes |
| `rewind`, `clear` | A cut of the chain | no | yes |
| `harness.session` | A harness's session id | no | no |

Nothing writes `attachment.added`, `session.title` or `harness.session` yet. Streamed text deltas (`thread.progress`), computer status, the takeover negotiation, usage and facts about the bot or the group stay out of the log, in the `events` table or their own tables.

## Child sessions keep their own trace

A thread owns one main session, a routine run or a helper runs in a child session that keeps its trace, and everything addressed to the person rises to the main session.

A session's `kind` is `thread`, `subagent` or `routine`. A thread points at its main session through `threads.sessionId`. A subagent session points at its parent session and at `parentEntryId`, the `tool.call` that launched it. A routine session points at its parent session only. Neither has a thread.

`routeOf` in [`sessions.ts`](../packages/db/src/sessions.ts) decides where an entry lands. A child session at any depth keeps its run's trace, the `RUN_TRACE_TYPES`: `run.*`, `assistant.text`, `assistant.reasoning`, `tool.*` and `subagent`. An `assistant.text` that holds an MCP approval is not trace. Anything else, such as an ask, an approval, the person's answer or a learned skill, goes to the top-most ancestor with a thread. The store sets `originSessionId` on it, the child it came from, so the thread names the routine or helper and links to it. The split keeps a routine's or a helper's tool calls out of the person's next question, and every question to the person where the person talks.

A routine run opens its own session in `openRoutineSessionInTransaction`. The main session gets `routine.started` at launch and `routine.finished` at the end, with the final words, the status and the usage. The thread folds both into one card that opens the routine session.

A helper starts from the parent run's `run_subagent` call, in `startSubagent` in [`executor.ts`](../packages/adapters/src/executor.ts). It gets a child session and a `Run` row with `parentRunId`. When it ends, the parent session gets one `subagent` entry with the result, which answers the call.

A child session reads joined. `readRun` returns a run's entries from every session it wrote to, with the person's answers to its asks and the later state of its cards, in time order. `sessions.entries` reads a child session this way, so a routine's session shows the ask it raised and its answer among its own steps.

## Two projections read the same entries

The model and the person read the same entries through pure functions in `packages/core`, where `projectInferenceTurns` builds the model's turns and `projectThreadView` builds the thread's rows.

Both start from `foldRuns` in [`run-fold.ts`](../packages/core/src/session-log/run-fold.ts), which folds a run's `assistant.*` and `tool.*` entries into one message per stretch. Any other entry closes the stretch, except `subagent` and the card-state entries. `toolAnswers` pairs each `tool.result` or `subagent` entry with the latest earlier unanswered call of the same run and call id, because providers reuse ids such as `call_0`.

**Inference.** [`project-inference.ts`](../packages/core/src/session-log/project-inference.ts) keeps the types whose audience is `yes` or `context`. It drops a tool call with no answer, and a cancelled run replays only its answered calls. Only the leading compaction becomes a turn. A `subagent` entry adds no turn, because its `result` replays as the output of the `run_subagent` call. `routine.started` is a context line. `routine.finished` replays the final words as the bot's own turn, or a context line when the routine failed or was cancelled without any.

**Thread.** [`project-thread-view.ts`](../packages/core/src/session-log/project-thread-view.ts) is the chain web and mobile call. It cuts what a rewind or clear removed, projects items with [`project-ui.ts`](../packages/core/src/session-log/project-ui.ts), adds the live layer, then folds reactions, groups, routine runs and time markers. A `ThreadItem` is a `message`, `run`, `subagent`, `routine`, `handoff`, `botMessage`, `divider`, `effect` or `note`. A `run` item draws nothing, since its reply is its bubbles and its steps.

Clients receive entries, never items. A card's later state is a new entry, such as `card.answered`, whose payload names the card as its `target`, because `parentId` stays the link to the head. No entry changes after it is written, so a client only merges new entries, and a reload and a second tab agree. Three things stay outside the log on purpose:

- Streamed text, the `thread.progress` layer under the shimmer, which the run's next entry clears.
- Facts about the bot, the group and the queue, such as members, computer status and active runs, read from their tables.
- The takeover negotiation.

## Compaction bounds what a run reads

A reader walks `parentId` back from the head, and the newest compaction on the chain stops the walk at the last `seq` its summary covers, `coveredUpToSeq`.

A run reads the tail. It is the compaction, the kept window of real turns after `coveredUpToSeq`, and everything since. `readTail` puts the compaction first, so the summary comes before the older turns it kept. A walk also stops at an entry with no parent. Here the compaction at seq 53 covers up to seq 40.

```text
seq    0 ... 40     41 ... 52     53           54 ... 60
       summarized   kept window   compaction   since
read   53, 41 ... 52, 54 ... 60
```

B is the history budget, the model's context window less a 16 384 token reply reserve and the rest of the request, never under 20 000 tokens. After a run, the executor enqueues a compaction once the turns after the last summary pass B/2 tokens. The job keeps the newest exchanges within B/4 tokens, at least one, and summarizes the rest. Without a known context window, the trigger is 20 000 tokens and the kept window 10 000. A thread with no owning bot, such as a group, or on a runtime that cannot compact, reads the newest 200 entries.

The job appends on the head it read. If the session moved on, the append fails, and the job retries once when only new turns landed or drops its work. The budget is in [`history-compaction.ts`](../packages/adapters/src/history-compaction.ts) and the walk in [`postgres.ts`](../packages/adapters/src/session-log/postgres.ts).

## Bots talk through three entry types

Three entry types carry what bots say to each other. For the model, another bot's words are a `<bot_message>` user turn, and a bot's own words stay on its assistant side.

- `handoff` records a group bot that passes the turn, in the group thread's session. `handoffToGroupBot` in [`group-handoff.ts`](../packages/adapters/src/group-handoff.ts) writes it, and the next bot's run names it as its `handoff` trigger.
- `bot.message.sent` lands in the sender's session and `bot.message.received` in the receiver's. `appendBotMessageInTransaction` in [`bot-messages.ts`](../packages/adapters/src/bot-messages.ts) writes both in one transaction, for `message_bot` and for connected agents. The receiver's run names the received entry as its `bot_message` trigger.

Every message of an exchange carries its `exchangeId`, the id of the first `bot.message.sent`, and a `hop` count. A chain of bot-started deliveries stops at six hops, except a last report back to the bot that asked.

A `bot_message` run whose reply goes back to the peer is a hidden peer run. The thread shows only what it addressed to the person: its asks, choices and approvals, its card states, its bot messages and its `message_user` words. `visibleEntries` in [`project-thread-view.ts`](../packages/core/src/session-log/project-thread-view.ts) is that filter, and the server applies it.

## The feed carries appended entries

The `events` table stays the ephemeral feed, and each transaction that appends entries to a thread emits one `session.entry.appended` event that carries all of them.

`appendSessionEntryInTransaction` in [`sessions.ts`](../packages/db/src/sessions.ts) inserts the event with the first entry, and later appends in the transaction add to it, so the feed holds each entry once. A child session's own trace has no feed, but what it raises does.

`threads.get` reads its snapshot under the thread's share lock in [`thread-target.ts`](../apps/api/src/thread-target.ts). It returns the newest 200 chain entries, `olderCursor`, the event cursor, the runs, and the members or the computer status. It also returns the open runs' `thread.progress` events newer than their last entry, so a reload mid-run keeps the live text. `threads.messages` pages back from `olderCursor`, or around an entry for a search jump, in [`thread-message-pages.ts`](../apps/api/src/thread-message-pages.ts). Entries on pages and on the feed leave out `sessionId`, and the server drops what a hidden peer run did not address to the person.

Web, in [`thread-events.ts`](../apps/web/src/lib/thread-events.ts), and mobile, in [`api.ts`](../apps/mobile/lib/api.ts), share one reducer rule through `applyEntryEvent`. On `session.entry.appended`, merge the entries by id in `seq` order, then project. A rewind or clear needs no refetch, because the projection cuts the chain.

## Postgres stores the log and JSONL moves it

Postgres holds the log in the `sessions` and `session_entries` tables, and JSONL is the serialization at the edges.

In [`schema.prisma`](../packages/db/prisma/schema.prisma), `sessions` owns identity, with the kind, the thread, the parent session and entry, `nextEntrySeq` and `headEntryId`. `session_entries` keeps the envelope as columns and everything else in the `payload` jsonb. A field earns a column only when a query filters, sorts, joins or locks on it.

Every append locks the thread, then the session row, the order a stop takes too, so appends to a session serialize without a deadlock. Several processes write one session, so the store is a table and not a file per session.

The port is `SessionLog<Tx>` in [`interfaces.ts`](../packages/adapter-kit/src/interfaces.ts), with `createSession`, `append`, `readTail`, `readPage`, `readAround`, `readRun` and `readEntry`. It has two backends:

- `PostgresSessionLog` in [`postgres.ts`](../packages/adapters/src/session-log/postgres.ts), which the API and the worker use.
- `FileSessionLog` in [`file.ts`](../packages/adapters/src/session-log/file.ts), one JSONL file per session for export, import, fixtures and a single process install, read through [`jsonl.ts`](../packages/core/src/session-log/jsonl.ts).

[`conformance.ts`](../packages/adapters/src/session-log/conformance.ts) runs the same cases on both backends offline, Postgres on in-memory PGlite.

Harness sessions, such as those of the Claude Code CLI or OpenCode, stay in the harness's own store. The log records only a `harness.session` entry with the id.

## Principles behind the shape

- A field earns a column only when a query needs it, and a new entry type is a payload schema and an audience row.
- An entry is admitted only when a person expects to see it again.
- A state change is a new entry that names its target, never a rewrite, so clients only merge.
- Frontends express intent and render state, as [AGENTS.md](../AGENTS.md) requires, and the projection is the same code on every surface.
- Every provider sits behind a port with an offline conformance test, here [`conformance.ts`](../packages/adapters/src/session-log/conformance.ts).

Later work, such as a run detail view and forking a conversation from any entry, is in Appendix D of the [session log plan](plans/2026-10-10-thread-log.md).
