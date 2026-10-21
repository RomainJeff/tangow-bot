# OpenCode execution in P4

## Decision

Keep OpenCode on the computer for P4. The computer image already installs the
CLI and startup links `/managed-skills/computer` into
`~/.config/opencode/skills`. The worker template has no OpenCode installation.
Adding it would also require its own authentication, skill loading and job
lifetime rules. The CLI MCP bridge is outside P4.

The worker does direct repository work with native file tools and `bash` on the
mounted volumes. It sends commands needing an app, browser or computer-local
service through `computer_exec`. Delegating to OpenCode is also a computer
operation, including code-only commands inside that job. This wakes the computer.
Revisit worker installation when code-only OpenCode delegation must avoid that
wake-up. No template or executor change is part of N12.

Rakazo tool names in these docs are logical names. Each harness supplies its own
naming, so callers use the offered tools without constructing an MCP prefix.

## Files and processes

| Item | Worker | Computer |
| --- | --- | --- |
| Private repository and brief | `/workspace/bots/<id>/<repo>` and `/workspace/bots/<id>/briefs/` | Same mounted paths |
| Intentionally shared repository | `/workspace/shared/<repo>` | Same mounted path |
| Bot workflow skills | `/managed-skills/agent`, linked into the worker's `~/.agents/skills` with bot and shared skills | `/managed-skills/agent`, used to invoke the helper |
| Managed coding skills for OpenCode | No OpenCode loader | `/managed-skills/computer`, linked by startup into `~/.config/opencode/skills` |
| New P4 job files | `/workspace/bots/<id>/oc-jobs/<job>/` | Same mounted directory, including `repo/`, `REPORT.md`, logs and metadata |
| OpenCode process, credentials and sessions | None | Computer process and home-local OpenCode state |

Set `OC_JOBS_DIR=/workspace/bots/<id>/oc-jobs` on every helper invocation, using
`computer_exec` with `cwd=/workspace/bots/<id>`. Invoke
`/managed-skills/agent/delegate-to-opencode/scripts/oc` there, rather than a
worker-home skill symlink. Create the brief with the worker's native `write` and
pass its absolute volume path to `oc start`. Do not use `/home/rakazo` for a
repository, brief or new P4 job directory. Existing computer-only callers keep
`$HOME/oc-jobs` when they omit the override; do not silently move those jobs.

All lifecycle commands must use the same job directory and computer. The volume
preserves files, not a portable running process or session. After a worker turn
ends, the computer can continue a detached job. After a computer restart, inspect
its process and report before trusting a saved PID. After computer replacement,
start a new job against the preserved branch with a fresh brief; `oc send` needs
the original computer's OpenCode session state.

The helper does not copy uncommitted changes into the new worktree. Commit the
intended repository baseline first. A worker command cannot reach a service at
the computer's `localhost`; run its command through `computer_exec` and use the
Rakazo browser tools for interaction with that service.

## N13 live lane, not run by N12

Use the N13 E2B host with a worker-enabled bot, a disposable repository on its
private volume, a computer image with OpenCode and a configured model account.
Keep credentials and raw infrastructure receipts outside the public repository.

1. Begin with the computer asleep. Ask the worker to edit a fixture in
   `/workspace/bots/<id>/<repo>` and run an offline check using native tools.
   Confirm the change on the volume and that the computer was not provisioned.
   Commit the fixture baseline before delegation.
2. Read the delegation skill in the worker. Write a brief under the bot's
   `briefs/` directory asking for a small fixture change and a report identifying
   the managed `own-the-task` skill it followed. Require it to load that skill
   before editing and include one instruction from it in the report.
3. Through `computer_exec`, run `oc doctor` and `oc start` using the managed
   computer path, the mounted repository and brief paths, and the same absolute
   `OC_JOBS_DIR` for both commands. Confirm readiness and a returned job id.
   Record that the computer woke for delegation.
4. On a later worker turn, use `computer_exec` for `oc status` and `oc result`.
   Verify the job's real Git worktree and changed fixture under
   `/workspace/bots/<id>/oc-jobs/<job>/repo`, on its `oc/<job>` branch. Read its
   report from the worker. Verify OpenCode actually loaded the managed coding
   skill in its session evidence, and compare its reported instruction with the
   mounted skill. A directory listing alone does not prove skill loading.
5. Send a small follow-up from another volume brief. Confirm it resumes the
   same OpenCode session on the same computer and updates that worktree. Run an
   independent review and retrieve its result through the same helper path.
6. Start a disposable localhost service on the computer through `computer_exec`.
   Verify it through a computer command and Rakazo browser tools. Confirm that
   worker `localhost` does not reach it. Stop the fixture service afterward.
7. Clean the completed job on the computer. Confirm the worktree is removed,
   its branch remains, and the source repository has no unintended changes.

Record pass, fail or blocked for each step, including the repo, worktree,
loaded-skill evidence and same-session follow-up. N12 supplies the lane text;
N13 owns execution and live receipts.

## Independent review disposition

The founding-engineer review accepted keeping OpenCode on the computer and the
single `OC_JOBS_DIR` override. Both recommendations were accepted. Its requested
qualifications are included above: delegated code runs on the computer, and
volume persistence does not make processes or sessions portable. The offline
suite retains the default home-directory case as well as the volume override.
