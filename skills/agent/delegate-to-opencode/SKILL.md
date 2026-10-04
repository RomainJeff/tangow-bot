---
name: delegate-to-opencode
description: Delegate multi-file repo work to OpenCode on the computer, review it.
---

Use this when the user wants code written or changed across several files in a repository that is already cloned on the computer, and the work would take you many shell round-trips. Do not use it for one-line edits, questions about code, or anything outside a repository.

The computer's `shell` refuses commands it cannot inspect: anything with `$...` expansions, backticks, `kill`, `pkill`, `eval` or `source`. Every command below passes as written; do not add `echo $!`, `kill -0` or `cd <repo> &&` to them. Run commands from the repository with the `shell` tool's `cwd` parameter.

1. Check the tool and its login: `command -v opencode && opencode auth list`. If the first line is empty, say OpenCode is not installed on this computer and do the work yourself or ask the user. If the list reports `0 credentials`, stop: OpenCode would fall back to its free default model and send the repo's code to a third party. Ask the user to run `opencode auth login` in the computer's terminal; you never handle credentials.
2. Make sure the repository is cloned and on the right branch (`git -C <repo> status --short --branch`). Create a branch if the user did not name one.
3. Write the task to a file with the `write_file` tool, path `opencode-<id>.md` (pick `<id>` yourself: short, unique per run). One clear brief: what to change, where, how to verify (which tests or commands), what not to touch, and the user's constraints verbatim. Never paste the task inline in a command. `write_file` lands in your folder; run `pwd` once with `shell` (no `cwd`) to learn its absolute path, `<dir>` below.
4. Start OpenCode in the background with `shell` and `cwd` set to the repository path; the `shell` tool stops after 5 minutes and OpenCode often needs longer. The marker file is how you know it finished:

   ```bash
   nohup bash -c 'opencode run "Do the task in the attached file." -f <dir>/opencode-<id>.md; touch /tmp/opencode-<id>.done' > /tmp/opencode-<id>.log 2>&1 &
   ```

5. Poll within the same turn, in short calls that each stay well under the 5-minute limit:

   ```bash
   sleep 30; test -e /tmp/opencode-<id>.done && echo finished || echo running; tail -n 40 /tmp/opencode-<id>.log
   ```

   Repeat until it prints `finished`. Tell the user it is in progress. If the log stalls for a long time or asks for a login, report it: the user runs `opencode auth login` in the computer's terminal. If you must end your turn before it finishes, say that OpenCode `<id>` is still running on the computer and that asking you to check on it resumes the same poll command.
6. When it has finished, review before reporting:
   - `git -C <repo> status --short` and `git -C <repo> diff` (or `git log -p` if OpenCode committed). Read the whole diff.
   - Run the repository's tests or the verification you specified. Quote failures exactly.
   - If the result is wrong or incomplete, start a second run with a new `<id>` and precise corrections rather than editing by hand, unless the fix is trivial.
7. Summarize for the user: files changed, what the change does, test results, anything left open. Remove the brief and marker (`rm -f <dir>/opencode-<id>.md /tmp/opencode-<id>.done`); keep the log. Do not push or open a pull request unless the user asked.
