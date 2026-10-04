---
name: delegate-to-opencode
description: Delegate multi-file repo work to OpenCode on the computer, review it.
---

Use this when the user wants code written or changed across several files in a repository that is already cloned on the computer, and the work would take you many shell round-trips. Do not use it for one-line edits, questions about code, or anything outside a repository.

1. Check the tool is there: `command -v opencode`. If it prints nothing, say OpenCode is not installed on this computer and do the work yourself or ask the user. Stop here.
2. Make sure the repository is cloned and on the right branch (`git -C <repo> status --short --branch`). Create a branch if the user did not name one.
3. Write the task as one clear paragraph: what to change, where, how to verify (which tests or commands), and what not to touch. Include constraints the user gave verbatim.
4. Start OpenCode in the background; the `shell` tool stops after 5 minutes and OpenCode often needs longer:

   ```bash
   cd <repo> && nohup opencode run "<task>" > /tmp/opencode-<id>.log 2>&1 &
   echo $!
   ```

   Keep the pid. Pick `<id>` yourself (short, unique per run).
5. Poll on each turn, never with a long timeout: `kill -0 <pid> && tail -n 40 /tmp/opencode-<id>.log`. While it runs, tell the user it is in progress. If the log stalls for a long time or asks for a login, report it: the user runs `opencode auth login` in the computer's terminal, you never handle credentials.
6. When the process exits, review before reporting:
   - `git -C <repo> status --short` and `git -C <repo> diff` (or `git log -p` if OpenCode committed). Read the whole diff.
   - Run the repository's tests or the verification you specified. Quote failures exactly.
   - If the result is wrong or incomplete, start a second run with precise corrections rather than editing by hand, unless the fix is trivial.
7. Summarize for the user: files changed, what the change does, test results, anything left open. Do not push or open a pull request unless the user asked.
