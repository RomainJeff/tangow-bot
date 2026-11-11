# Usage breakdown (Lens)

## Why

Settings › Usage shows one line: `N runs · N tokens`. It can't tell which bot spends, on which model, or whether auto routing sends work to the right category. The "runs" figure is also wrong today: `usage/summary` counts usage records (one per model call), not runs.

## What the person gets

Design B ("Lens"), validated on the interactive mockup:

- Period: `7d · 30d · All` segmented control, top right.
- Header group: input tokens and output tokens as **two separate figures**, runs, and per-run averages split the same way (`41k in · 6k out / run`). One share bar, split by the active tab.
- Tabs `Bots · Models · Categories` drive a single list. Each row: lead (bot avatar / ink dot), name, sub-line `N runs · Xk in · Yk out / run`, trailing `Xk in · Yk out` with the share in %.
- Tapping a row opens the same view filtered on it; its own tab disappears, `‹` goes back. Bot › Models/Categories, Model › Bots/Categories, Category › Bots/Models.
- Input and output are never added together in any figure. The share bar and the sort order use input + output only as an ordering key, never as a displayed number.
- Colour: bots use their own colour; deleted bots a neutral grey avatar with a `Deleted` tag. Models and categories use an ink ramp (`foreground`, `mutedForeground`, `foregroundSubtle`, `input`). Only the share bar collapses the 5th segment and later into one; the list always shows every row, reusing the 4th shade.
- Category values: `Fast`, `Everyday`, `Complex`, `Fixed` (no category picked the model: a model pinned on the bot, routing off, a routing fallback to the default), and `Compaction`.
- Compaction is a row of the Categories tab, so a bot's compaction spend shows when you open the bot (Bot › Categories) and the tab still adds up to the header. Its sub-line counts compactions instead of runs: `12 compactions · 98k in · 6k out / compaction`. Opening it shows which bots and models compact. Usage recorded before this ships has no category and shows as `Not recorded`, as does the team-chat judge, left untouched until it is removed (#445).

Surfaces: web and Electron (settings overlay), iOS and Android (account › Usage becomes a pushed native screen with the same view; the Expo route is cross-platform).

## How

### 1. Record the category and the compaction (db + adapters)

- Migration: nullable `category String?` and `compactionId String?` on `UsageRecord` only. The existing `(spaceId, userId, createdAt)` index covers the query. No column on `Run`: the category already lives in the run's `run.started` log entry.
- `openRunLog` returns the run's `RunModelDecision`: the `routing` it was given on a fresh run, or the logged `run.started` payload on a resumed or helper run (it already loads that entry). One mapping, `decision.category ?? "fixed"`, feeds `recordRunUsage`, which writes it on the usage row.
- The team-chat judge is left as is (`null` category, `null` runId); removing it is tracked in #445.
- Compaction writes `"compaction"` and a random `compactionId` generated once per `compactHistory` pass and carried on the `CompactionThread` object it already hands to `summarize` and `learnDurableFacts` (the comment saying `UsageRecord` can't tell them apart goes), so its summary chunks and fact extraction calls count as one compaction. A pass that is dropped because the session moved on still spent its tokens and still counts.

### 2. One read endpoint (contracts + api)

- `usage/breakdown` with input `{ period: "7d" | "30d" | "all" }`, scoped to the actor's space and user like `usage/summary`.
- One SQL `GROUP BY botId, provider, model, category, (runId IS NOT NULL)` returning cells: `{ bot: { id, name, color, identity, shapeSeed } | { id, name, deleted: true }, provider, model, category | null, hasRun, runs: COUNT(DISTINCT runId), compactions: COUNT(DISTINCT compactionId), inputTokens, outputTokens }`. Bot fields by LEFT JOIN on `bots` (everything `BotAvatar` needs), then `bot_deletions` for a deleted bot's name.
- Per-run averages use `hasRun` cells only; compaction and judge tokens count in totals, never in a per-run average. The Compaction row averages over compactions instead. A helper run counts as a run of its bot. A deleted bot's runs are gone with it, so it shows tokens with `0 runs` and no average.
- `usage/summary` and `usage/list` are removed once both clients use the new endpoint (no other caller).

### 3. Shared pivot (packages/core)

- A pure `pivotUsage(cells, { dimension, focus })` returns the header totals and the sorted rows for one tab, input and output kept apart. One rule per row: with run cells it shows runs and a per-run average; with none but compactions, compactions and a per-compaction average; with neither, no sub-line. Mixed rows stay on runs, their compaction tokens count in the totals. Web and mobile call it; no aggregation logic in either app.

### 4. Web

- `UsageSettingsPanel` rewritten with `SegmentedControl`, `SettingRow` (pressable, chevron) and `BotAvatar`. Drill-down is local state in the panel (`focus`), no route.
- One new primitive in `@tangow/ui-web`: `ShareBar` (segments + colours, tokens for height and radius), added to the design-system kitchen sink and `docs/design-system/primitives.md`.

### 5. iOS

- `apps/mobile/app/usage.tsx`: native segmented pickers, list rows with the shared tokens; drill-down pushes `usage?kind=…&id=…`. The account screen links to it instead of showing the inline line.

### 6. Tests and capture

- Unit: `pivotUsage` (tabs, focus, runless cells out of averages, Compaction row counted per compaction, `Not recorded`, deleted bot); the endpoint against a seeded db (period filter, distinct runs, one compaction pass with several calls counts once, in/out never summed, isolation from another user).
- E2E: extend `settings-shell.spec.ts` usage case: switch tab, drill into a bot, back; screenshots at desktop and 390×844. `pnpm test:mobile-screenshots` for iOS; Android is not captured by the tooling and is checked by hand.
- CHANGELOG `Changed` entry.

## Copy

New visible words: `7d`, `30d`, `All`, `Bots`, `Models`, `Categories`, `Fast`, `Everyday`, `Complex` (already used in model settings), `Fixed`, `Compaction`, `Not recorded`, `Deleted`, `in`, `out`, `runs`, `/ run`, `compactions`, `/ compaction`. No explainer text; the current "Model spend uses your provider keys." line is kept.

## Out of scope

Cost estimation (needs per-model prices), per-day charts, cache read/write tokens, export.

## Independent review (founding-engineer)

| Recommendation | Disposition |
| --- | --- |
| Drop `Run.modelCategory`, read the decision from the run log in `openRunLog` | Accepted: one source of truth, migration touches `usage_records` only |
| Add `hasRun` to the grouping so averages exclude runless tokens | Accepted |
| `Not recorded` would not age out while compaction/judge write `null` | Accepted for compaction (writes `"compaction"`); the judge is left untouched by the maintainer's call and goes away with #445 |
| Limit `Other` to the share bar, list shows every row | Accepted |
| Carry `identity`/`shapeSeed` for `BotAvatar`; handle zero-run deleted bots; state Android | Accepted |
| Open question: routing fallback with no category | Resolved: `category ?? "fixed"`, the default model ran, which is what `Fixed` means |
| Keep `pivotUsage` in `packages/core` and the cells endpoint | Kept, as the reviewer advised |

### Second review, compaction addition

| Recommendation | Disposition |
| --- | --- |
| Keep `compactionId`, random per pass; session-log entries and `runId` can't do it | Kept |
| One sub-line rule in `pivotUsage` (runs, else compactions, else nothing) | Accepted |
| Carry the id on `CompactionThread`, not a new parameter; fix the stale comment | Accepted |
