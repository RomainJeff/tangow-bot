# Troubleshooting

Always start with `<oc> result <id>`: the report, or OpenCode's last message, usually says what went wrong. On `failed` it also shows the last error lines; `<oc> status <id> --detail` adds the failed tool calls and errors from the run.

## `failed`

- **Error mentions credentials, auth, 401, quota or rate limit**: the model account is not usable. Run `<oc> doctor`, then `references/setup.md`. Quota or rate limit: tell the user their AI account hit its limit and offer to retry later with a reminder.
- **Error mentions a model not found**: drop `--model` or pick one from `opencode models` (run it through `computer_exec`).
- **The report says it could not finish** (tests red, missing information): if the gap is information only the user has, ask them one simple question, then `<oc> send <id> <file>` with the answer. If it is technical, send one follow-up restating the failing criterion; after two failed follow-ups, tell the user plainly what blocks.
- **Nothing useful in the result**: start the job again once with the same brief. Fails again: tell the user and suggest a smaller task.

## `stalled`

No progress for over 10 minutes; it may be a long test run, or stuck. `<oc> status <id> --detail` shows its last action and where it is in its todo list. Check once more on the next reminder. Still stalled after 30 minutes, or running over 2 hours in total: tell the user, then `<oc> stop <id>` and `<oc> result <id>` to see what was done; the work so far stays on the branch. Restart with a smaller brief if needed.

## `stopped`

You or the user stopped it, or the bot's run was stopped. Ask the user whether to restart. `<oc> send <id> <file>` continues the same session with its context ("Continue where you stopped.").

## `state=busy`

Three jobs already run. Tell the user, offer to wait (a reminder) or to stop the least urgent one.

## Merge conflicts

Each job works on its own branch from the repository's state when it started. Two jobs touching the same files can conflict when combined. Do not resolve it yourself: start a job whose brief asks to bring branch `oc/<a>` up to date with `oc/<b>` (or the base branch), resolve the conflicts, keep both features and rerun the tests.

## `<oc> clean` refuses

- "is running": stop it first, or wait.
- "uncommitted changes": ask OpenCode to commit them with `<oc> send`, or add `--force` if the user confirmed the work is not wanted.

## The computer restarted

A restart can interrupt a job. The volume keeps its branch, metadata and report, but a saved PID does not prove that OpenCode survived. Check the report and computer process before relying on `status`. On the same computer with its OpenCode session state intact, `<oc> send <id> <file>` can continue the session. After computer replacement, start a new job against the preserved branch and restate the remaining work; a session id alone cannot restore the session.
