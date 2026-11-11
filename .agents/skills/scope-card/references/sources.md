# Sources

## Personal config (`~/.config/tangow/scope-card.json`)

| Key | Meaning |
|---|---|
| `notion.dataSource` | The kanban's data source (`collection://…`), from fetching the kanban database. |
| `notion.toolPrefix` | Which Notion connector to use when several are attached (for example `mcp__notion__`). |
| `github.repos` | Repos whose open PRs are checked for duplicates (the fork and upstream, for a fork). |
| `base` | The branch the scout worktree follows (`origin/main` in a fork, `main` otherwise). |
| `permalinkRepo` | The GitHub `owner/repo` whose `base` the scout worktree mirrors, for code permalinks. |
| `scoutWorktree` | A worktree reserved for scouting, detached on `base`. |
| `refsDir` | Where reference repos are cloned. |
| `referenceRepos` | Extra reference repos: `{ "name", "url", "frozen"?: true, "sparse"?: true, "about" }`. Added to the defaults below. `frozen` means never refreshed (archived repos). |
| `localSources` | Local files or folders worth reading for some cards, with what they cover: `{ "path", "about" }`. For example a digest you wrote of another product's behaviour. |
| `decisionDirs` | Folders holding past specs, designs and QA reports, searched for duplicates and past decisions. |
| `decisionLinks` | Past decision documents (Artifact links, Notion pages): `{ "url", "about" }`. Read them when the card touches their subject. |
| `langfuse.envFile` | A file defining `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and optionally `LANGFUSE_BASE_URL` (default `https://cloud.langfuse.com`). Omit `langfuse` to skip traces. |

## Default reference repos

`scripts/refs.py sync` clones these plus `referenceRepos`: shallow, large blobs filtered, no LFS, binaries left out of sparse clones. It refreshes a clone when its last fetch is older than 7 days, never a `frozen` one, and prints each SHA for permalinks.

| Repo | What it is | Known facts (dated, re-check when they matter) |
|---|---|---|
| `openclaw/openclaw` (sparse) | Open-source personal agent with heartbeat and channels | Heartbeat with `NO_REPLY` and `HEARTBEAT_OK` tokens stripped by the runtime, `activeHours` enforced outside the prompt, "standing intents" (keyword-triggered prospective memory with cooldown and max fires). Criticised for heartbeat cost and CVEs. Sentinels leaked into chat through a fallback path, fixed in March 2026. |
| `NousResearch/hermes-agent` | Open-source agent with cron, gateway and skills | `[SILENT]` for autonomous runs, filtered before delivery, valid only when the run succeeded. Cron prompts tell the model not to deliver itself; delivery belongs to the runtime. Memory files are capped and error when they overflow. |

## Products without public code (web scout)

| Product | Known facts (dated) |
|---|---|
| Meta Muse | Personal agent launched on 2026-09-08 (distinct from the Muse Spark model). Works in the background, decides itself whether a result deserves a notification, user slider for unsolicited messages (fewer / more / off). Criticised for aggressive data collection. |
| ChatGPT Dots | Always-on ChatGPT agents announced at OpenAI DevDay on 2026-09-29: a cloud computer and browser per dot, a standing responsibility, messages or calls when a decision is needed, the notification rule written in the instruction ("message me only if…"), routing by channel (ChatGPT, Slack, Teams). |

## In this repository

- `references/ai-agent-ux-patterns.md`: the primitives bench. §1 principles · §2 moments of an agent run · §3 the best of messaging apps (Slack, WhatsApp, Telegram, iMessage) · §4 cross-cutting patterns · §5 anti-patterns · §6 design checklist. It does not cover collaboration tools (Linear, Notion, Figma).
- `docs/design-system.md`, `packages/ui-tokens`: for mockups.
- `skills/` (managed bot skills) and the bot's built-in tools: what the bot is told today.

## Langfuse traces

`scripts/langfuse-pull.py` writes a local JSONL extract (one observation per line, input and output truncated) and prints the trace URL prefix. One run is an `AGENT` observation named `run-agent` (metadata `botId`, `runId`, `model`) with its `GENERATION` and `TOOL` children. The run's trigger (message, routine) is not in the metadata: infer it from the input. The extract may contain conversation excerpts: it stays in the scratchpad and never goes into Notion.

## Prompts for "what else should we look at?"

Not a closed list: each card can suggest a source this list does not.

- **Sharing, multiplayer, spaces, permissions, invitations** → collaboration tools absent from the bench: Linear, Notion, Figma, Google Docs, Discord, Slack Connect.
- **Agent moments** (plan, approval, steering, end of run) → other agent clients: Claude apps and Claude Code, ChatGPT, Cursor, Codex, Devin.
- **iOS, gestures, accessibility** → Apple Human Interface Guidelines, WCAG 2.2; Material when Android comes up.
- **Bot to bot, bot to tool, integrations** → the MCP and A2A specs, the target service's docs.
- **Reliability, bot behaviour** → Langfuse traces, server logs (commands for the user), reference project issues.
- **Relevance and proactivity** → past decision documents in the config, recent research when the topic is new.
- **Copy, tone, i18n** → conventions of the reference messaging apps, `AGENTS.md` (every visible word is UI).
