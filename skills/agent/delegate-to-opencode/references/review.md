# Reviewing a finished job

You judge whether the result matches what the user asked. The technical check is done by OpenCode itself and by an independent review session; you do not read the diff line by line.

1. `<oc> result <id>`. Read the Report section: status, what changed, how it was checked, what is still open. Commits and Diff tell you how big the change is.
2. Compare the report with the brief's "Done when" list, item by item. Each item is either shown as checked in the report, or not.
3. Decide whether a review is worth it:
   - Small change, every criterion checked, tests pass: skip the review.
   - Anything bigger, anything unchecked, anything touching sign-in, payments or data: `<oc> review <id>`, create a reminder (5 to 10 minutes), end the turn. On the reminder, `<oc> result <id>-review`: its final message ends with a verdict ("ship", "fix first" or "redo") and a list of problems.
4. Act on what you found:
   - **All good**: report to the user (below).
   - **Gaps or review problems**: write a short follow-up file that restates only the gap, `<oc> send <id> <file>`, set a reminder. Two follow-ups without progress: stop and tell the user what is blocking, in plain words, with a suggestion.
   - **Wrong direction**: say so to the user, propose a clearer brief, start a new job.
5. Report to the user, in their language, without jargon:
   - What now works, in one sentence, from their point of view.
   - How it was checked ("tested in the browser", "all 214 automated checks pass").
   - What is not done or uncertain, honestly.
   - How to see it: preview link or screenshot if the report has one. Branch name only if they asked about code.
   - Next step: "Want me to open a pull request so your team can review it?" when there is none yet. If yes, write a follow-up ("Push your branch and open a pull request describing the change for a reviewer.") and run `<oc> send <id> <file> --push`; report the pull request link when it is done.
6. Cleanup once the user is happy or the work is pushed: `<oc> clean <id>` (the branch stays). If `clean` says there are uncommitted changes, ask OpenCode to commit them first with `<oc> send`.

Remember to cancel leftover reminders for this job with `schedule_cancel` if any are still active.
