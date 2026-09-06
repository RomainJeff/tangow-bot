# Changelog

Notable product changes in Rakazo, newest first. See GitHub Releases for tagged builds.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### 2026-09-06

#### Added

- **Skills panel on mobile.** Browse, install and manage skills from the phone, not just the web app.
- **Skills repositories as marketplaces.** Point a marketplace at any GitHub repository laid out the `npx skills` / skills.sh way — `skills/`, `.claude/skills/`, `.agents/skills/`, or a bare `SKILL.md` at the root — alongside the usual `.claude-plugin/marketplace.json` marketplaces. Repositories of this kind get their own badge in the panel so you can tell them apart.
- **Install several skills in one go.** Multi-select in the Browse tab installs the whole selection in a single pass instead of one round trip per skill.
- **Plugins hosted in their own repository.** A repository that *is* a single plugin, or a plugin whose directory is itself a skill, installs like any other marketplace entry.
- **Import a `.skill` file as a zip.** The import picker now accepts `.zip` bundles on top of plain `SKILL.md` text and `tar.gz`, including the zips the macOS Finder produces from "Compress".
- **Choose who each skill reaches.** Every skill is Global, Specific, or off, with per-agent toggles in agent settings and a matching control in the Skills list.
- **Search and filter your skills**, with the toolbar pinned to the top of the list.
- **Agents get their own Skills section** in their settings — install-only, so agent-level changes can't disturb the shared library.
- **One Customize overlay.** Integrations and Skills now live side by side in a single overlay instead of two separate destinations.
- **A profile photo of your own**, on web, desktop and mobile.
- **See which tool a bot is on.** The "working" label next to the bot avatar shimmers and names the tool currently running.
- **Groups of one bot** are allowed, and a group can carry a description that is injected into its bots' prompts.
- **Threads mark day and time when they resume**, so a conversation picked up hours later reads in order.

#### Changed

- Group avatars pair a lone bot with the user's initials instead of showing a half-empty tile.
- 1080 empty entries in the message catalogs were translated — far fewer English strings leaking into other locales.
- Renaming a skill keeps its bundle files.
- Installed plugin trees are capped at 50 MiB, and a marketplace update writes its manifest only after every install has succeeded — a failed update no longer leaves a manifest describing plugins that aren't there.

#### Fixed

- A delegated bot's `ask_user` is actually answerable; `message_user` no longer collides with it.
- Groups without a description no longer break the web settings screen.
- The gap between the composer and the on-screen keyboard is closed.
- A zip whose own entries collide is reported as a bad bundle instead of installing something half-formed.
- Removing an installed plugin is guarded against path traversal.

### 2026-09-05

#### Added

- **Display agent steps.** A setting on web and mobile that shows what the bot did to get to its answer, expanded into a per-tool list with the details of each call.
- **Skills live on the filesystem.** Skills are stored as `SKILL.md` files under `DATA_DIR`, edited in the app with live validation, and read and written by the bot's own `skill_*` tools. Existing skills are migrated at boot.
- **Skills are scoped per bot.** A skill can be available to everyone or to a chosen set of bots; the slash picker in a thread only offers what the active bot can actually use. Skills a bot creates stay with their creator. Renames, deletions and bot duplication carry the scoping with them.
- **Open a bot-to-bot chat** straight from a peer chip on mobile.
- **`chattyReplies`, per bot** — a setting for how much a bot talks while it works.

#### Changed

- Bots stop narrating their own work through `message_user`.
- The server picker is reachable from settings, and the Cloudflare Access token sits behind a toggle instead of cluttering the form.

#### Fixed

- Threads that stored reasoning blocks load again.
- The window chrome stays reachable when the bots sidebar collapses.

#### Reverted

- The live, collapsible reasoning trail and the grouping of consecutive messages from the same speaker were both shipped and pulled back the same day.

### 2026-09-04

- A bot-level `chattyReplies` setting lands, and the stack is reconciled with upstream after a rebase.

### 2026-09-03

#### Added

- **Edit and resend a message.** Editing a message rewinds the thread to that point, on web and on mobile, so a bad turn can be replayed instead of worked around.
- **A Files tab in a bot's knowledge**, next to its memory and skills.

#### Changed

- Integrations are grouped into Featured, All and Installed, with what you already installed at the top.
- The rest of the web chrome is themed for light mode.
- Chinese strings seeded for the mobile integrations sections.

### 2026-09-01

#### Added

- **Reach a self-hosted server behind Cloudflare Access from mobile.** The service token can be entered in the server sheet or baked in at build time, and the Android notification poller sends it too. [Setup guide](docs/self-host.md).
- **Edit a bot's instructions on their own**, without walking through the rest of its settings.
- `curl`, `jq` and `poppler-utils` are available in the computer sandbox image, so bots can fetch, parse and read PDFs without improvising.

#### Changed

- Composio identities are scoped per space.

### 2026-08-31

#### Added

- **Reach a self-hosted server behind Cloudflare Access from the desktop app.** When the setup probe fails it now says why — transport error, network error code, or a redirect it never expected — instead of failing blank.
- **Bots keep a chosen organic avatar shape**, and colour and shape moved into a single avatar popover.

#### Changed

- The Cloudflare Tunnel moved into the base Compose file, so it is part of the standard self-hosted stack.
- The tool trail is spaced off the reply below it.

### 2026-08-30

- Docker Compose setup for macOS.

## [0.1.0-beta] - 2026-08-13

Initial public beta: web, Electron, and Expo clients; Pi runtime; Docker and E2B computers; plugins; one thread, computer, memory, routines, and history per bot.
