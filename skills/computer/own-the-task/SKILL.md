---
name: own-the-task
description: Take a task brief from Rakazo end to end on your own: onboard, plan, build, verify every done criterion, and write the REPORT.md the bot reads.
---

Follow this when a prompt says "Rakazo job" and points you here. The person who wrote the brief is not a developer and cannot answer questions while you work: you own the whole loop and decide on your own.

1. **Onboard.** Follow `repo-onboard` if you have not worked in this repository yet: conventions, stack, real commands, a baseline test run. Note tests that already fail before your change.
2. **Understand the goal.** Read the brief's Goal, the user's words and "Done when". When something is unspecified, take the most reasonable option that fits the Goal and the existing code, and note the choice for the report. Never stop to ask.
3. **Plan briefly.** Explore the code the change touches before editing. Write a short todo list: one item per done criterion plus the steps they need.
4. **Build in small steps** on the branch you are on, in the working copy you were given. Follow the repository's style. For bugs, follow `systematic-debugging` and write a test that reproduces the bug before fixing it; for new behaviour prefer `tdd`. Commit each working step with a clear message.
5. **Verify every done criterion yourself.** Run the tests, lint and typecheck the repository uses. For anything visible, follow `run-and-preview`: start the app, check the behaviour, take a screenshot and keep its path. A criterion you could not verify is reported as unverified, never as done.
6. **Review your own change** before reporting: read the full diff from the starting commit, remove debug code and unrelated edits, make sure nothing outside the brief changed.
7. **Deliver as the prompt says.** By default commit and do not push. If the prompt asks for a pull request, follow `pr-workflow`. Leave nothing uncommitted.
8. **Write the report** at the path the prompt gives, in this exact format:

```markdown
Status: done | partial | blocked

## What changed
<One or two sentences a non-developer understands: what the user can now do or see.>

## Done criteria
1. <criterion> — met | not met | unverified — <how you checked: command, test name, screenshot path>

## Decisions
- <Choices you made where the brief was silent, and why.>

## Open
- <Anything left, risks, follow-ups. "Nothing" if nothing.>

## Links
- Branch: <branch>
- Preview: <local URL or screenshot path, if any>
- Pull request: <URL, if one was opened>
```

Be honest in the report: "partial" with a clear reason is far more useful than "done" with a broken criterion. If you are blocked (missing access, information only the user has), stop, write the report with Status `blocked`, and say exactly what is needed in plain words.
