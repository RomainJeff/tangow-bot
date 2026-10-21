---
name: delegate-to-opencode
description: Hands coding work in a repository to OpenCode on the computer as background jobs (up to three in parallel), follows up on its own, gets the result reviewed and explains it in plain words. Use when the user asks to build, fix, change or plan code in a repository, or asks about a running OpenCode job; not for questions answered by reading a file or two.
---

Use this when repository work needs a background coding job. OpenCode runs on the computer, including its code-only subprocesses. For direct file edits, Git operations and offline checks, use the worker's native tools on the mounted repository. Do not use it for questions you can answer by reading a file or two.

When delegating, write the brief, judge whether the result matches what the user asked, and explain it in plain words. Assume the user is not a developer either; they should never need to open the computer.

## Execution and paths

In a worker run, use native `read`, `write`, `edit` and `bash` for file and code work under `/workspace/bots/<id>`. Use `computer_exec` for commands needing the computer's apps, browser, services or OpenCode installation. Worker `localhost` is a different machine. Use Rakazo browser tools for browser interaction.

Tool names here are Rakazo names. Each harness exposes them under its own naming. Use the offered tools, without assuming an MCP prefix. The in-process harness uses `shell` for computer commands and `write_file` for briefs.

`<dir>` below is `/managed-skills/agent/delegate-to-opencode` on the computer. Do not pass a worker home symlink or a worker-only path to `computer_exec`. Read references from the managed skill in the worker using native `read`.

In-process runs write `briefs/<name>.md` with `write_file`; the computer workspace maps it to `/workspace/bots/<id>/briefs/<name>.md` on both dedicated and team computers.

Write briefs under `/workspace/bots/<id>/briefs/` using native `write`. Use an absolute repository path under `/workspace/bots/<id>/` or `/workspace/shared/`. Both machines see those volume paths. For every helper command, use `computer_exec` with a literal command of this form:

```sh
OC_BOT_ID=<id> OC_JOBS_DIR=/workspace/bots/<id>/oc-jobs bash /managed-skills/agent/delegate-to-opencode/scripts/oc doctor
```

`<oc>` in every step and reference means `OC_BOT_ID=<id> OC_JOBS_DIR=/workspace/bots/<id>/oc-jobs bash <dir>/scripts/oc`, executed on the computer. Replace the bot id and command with the actual values. Set `cwd` to `/workspace/bots/<id>`. Keep the same `OC_JOBS_DIR` and computer for start, status, follow-up, review and cleanup. Jobs contain `repo/`, metadata, logs and `REPORT.md` under that directory. These files persist on the volume; running processes and OpenCode's home-local sessions do not move with them. Older computer-only callers may omit the override and keep `$HOME/oc-jobs`. Volume-backed calls accept absolute repository and brief paths only within this bot's private directory or `/workspace/shared`; `..` segments and symlink escapes are rejected.

OpenCode loads managed coding skills from `/managed-skills/computer` through the computer startup link at `~/.config/opencode/skills`. The bot's worker skill catalog is separate. Keep setup and authentication on the computer; see the [setup reference](references/setup.md).

## Job lifecycle

1. **Check.** `<oc> doctor`. Anything but `state=ready` (or a missing script): read `<dir>/references/setup.md` and follow it.
2. **Brief.** Read `<dir>/references/brief.md`, then write the brief on the bot volume as described above. One task per brief; two independent tasks are two jobs.
3. **Start.** `<oc> start --repo <absolute repo path> --brief <absolute brief path>`. It returns `id=<id>` in under two seconds. Options: `--plan` (read-only planning job), `--push` (only when the user asked for a pull request), `--effort high` (hard tasks), `--model <provider/model>`. `state=busy` means three jobs already run: offer to wait or stop one.
4. **Hand back.** Tell the user in one or two sentences what started and when you will report back (see `<dir>/references/talking-to-user.md`). Create a one-shot reminder with `schedule_create`: `delayMinutes` 10, a readable `name` such as "Follow-up: contact form", and a `prompt` saying "Check OpenCode job <id> with the delegate-to-opencode skill and report to the user." Then end your turn. Never wait or poll inside the turn.
5. **On the reminder.** `<oc> status <id>`:
   - `running`: create a new reminder 10 to 20 minutes later and end the turn without messaging the user.
   - `done`: read `<dir>/references/review.md` and follow it.
   - `failed`, `stalled` or `stopped`: read `<dir>/references/troubleshooting.md`.
6. **When the user asks how a job is going.** `<oc> status <id> --detail`. After the usual status line it prints the run totals (`steps`, `tools`, `failed_tools`, `tokens_in`, `tokens_out`, `cost`), `## Todo` (OpenCode's own task list, each item `[pending]`, `[in_progress]` or `[completed]`), `## Recent` (its last ten actions and messages, `(failed)` on a failed tool) and `## Errors` when it wrote any. Answer from the todo list in plain words ("it has finished the form and is running the checks"); also use it to understand a `stalled` or `failed` job.

Other commands: `<oc> status` (all jobs), `<oc> result <id>` (report, commits, change summary), `<oc> send <id> <file> [--push]` (follow-up in the same OpenCode session), `<oc> review <id>` (independent read-only review), `<oc> stop <id>`, `<oc> clean <id>` (removes the working copy, keeps the branch), `<oc> login openai|copilot` (sign-in by code).

Rules:
- Never ask for a password, API key or token in chat. Sign-in goes through `<oc> login` or `request_takeover`.
- Never poll in the turn: the reminder brings you back.
- Never show jargon, logs or diffs to the user without a plain-language translation.
