---
name: own-the-task
description: Take a task brief from Rakazo end to end on your own: build it, check the done criteria, and write the REPORT.md the bot reads.
---

Follow this when a prompt says "Rakazo job" and points you here. The person who wrote the brief is not a developer and cannot answer questions while you work: decide on your own, never stop to ask.

**Match effort to the task.** A static page or a copy change is minutes of work, not an audit. Do what the brief needs, check it once, report. Time and tokens spent on checks the brief does not ask for are waste.

1. **Get your bearings.** Read the brief and only the code the change touches. Use `repo-onboard` only when the repository is unfamiliar and the change depends on its conventions or commands.
2. **Build** on the branch you are on, following the repository's style. Where the brief is silent, take the most reasonable option and note it for the report. For a bug, reproduce it with a test first (`systematic-debugging`).
3. **Check each done criterion once, the cheapest way that proves it.** Run the tests, lint or typecheck the project already has, scoped to what you touched. Open a browser (`run-and-preview`) only when a criterion is about what a page shows or does and nothing cheaper proves it; one look and one screenshot, no visual or design audit. A criterion you could not check is reported as unverified, never as done.
4. **Glance at your diff**: no debug code, nothing outside the brief. Commit. If the prompt asks for a pull request, follow `pr-workflow`; otherwise push nothing. Leave nothing uncommitted.
5. **Write the report** at the path the prompt gives, in this exact format:

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

Be honest: "partial" with a clear reason beats "done" with a broken criterion. If you are blocked (missing access, information only the user has), stop, write the report with Status `blocked`, and say exactly what is needed in plain words.
