---
name: delegate-to-opencode
description: Hands coding work in a repository to OpenCode on the computer as background jobs (up to three in parallel), follows up on its own, gets the result reviewed and explains it in plain words. Use when the user asks to build, fix, change or plan code in a repository, or asks about a running OpenCode job; not for questions answered by reading a file or two.
---

Use this when the user wants code written, fixed or changed in a repository on the computer. OpenCode does the whole job (explore, code, test, preview) in the background while you stay free to talk. Do not use it for questions you can answer by reading a file or two.

You are not the developer here: you write the brief, you judge whether the result matches what the user asked, and you explain it in plain words. Assume the user is not a developer either; they should never need to open the computer.

`<dir>` below is the `dir` returned by `skill_read`. Run every command with the `shell` tool exactly as written, with literal arguments only.

1. **Check.** `bash <dir>/scripts/oc doctor`. Anything but `state=ready` (or a missing script): read `<dir>/references/setup.md` and follow it.
2. **Brief.** Read `<dir>/references/brief.md`, then write the brief with `write_file` (absolute path: run `pwd` once with `shell` and no `cwd`). One task per brief; two independent tasks are two jobs.
3. **Start.** `bash <dir>/scripts/oc start --repo <absolute repo path> --brief <absolute brief path>`. It returns `id=<id>` in under two seconds. Options: `--plan` (read-only planning job), `--push` (only when the user asked for a pull request), `--effort high` (hard tasks), `--model <provider/model>`. `state=busy` means three jobs already run: offer to wait or stop one.
4. **Hand back.** Tell the user in one or two sentences what started and when you will report back (see `<dir>/references/talking-to-user.md`). Create a one-shot reminder with `schedule_create`: `delayMinutes` 10, a readable `name` such as "Follow-up: contact form", and a `prompt` saying "Check OpenCode job <id> with the delegate-to-opencode skill and report to the user." Then end your turn. Never wait or poll inside the turn.
5. **On the reminder.** `bash <dir>/scripts/oc status <id>`:
   - `running`: create a new reminder 10 to 20 minutes later and end the turn without messaging the user.
   - `done`: read `<dir>/references/review.md` and follow it.
   - `failed`, `stalled` or `stopped`: read `<dir>/references/troubleshooting.md`.
6. **When the user asks how a job is going.** `bash <dir>/scripts/oc status <id> --detail`. After the usual status line it prints the run totals (`steps`, `tools`, `failed_tools`, `tokens_in`, `tokens_out`, `cost`), `## Todo` (OpenCode's own task list, each item `[pending]`, `[in_progress]` or `[completed]`), `## Recent` (its last ten actions and messages, `(failed)` on a failed tool) and `## Errors` when it wrote any. Answer from the todo list in plain words ("it has finished the form and is running the checks"); also use it to understand a `stalled` or `failed` job.

Other commands: `oc status` (all jobs), `oc result <id>` (report, commits, change summary), `oc send <id> <file> [--push]` (follow-up in the same OpenCode session), `oc review <id>` (independent read-only review), `oc stop <id>`, `oc clean <id>` (removes the working copy, keeps the branch), `oc login openai|copilot` (sign-in by code).

Rules:
- Never ask for a password, API key or token in chat. Sign-in goes through `oc login` or `request_takeover`.
- Never poll in the turn: the reminder brings you back.
- Never show jargon, logs or diffs to the user without a plain-language translation.
