# Writing the brief

The brief is the only thing OpenCode knows about the user. Its quality decides the result. Current coding agents (Claude, GPT-5 class models) work best with a verifiable goal and context, not a list of steps: they explore, plan and check by themselves. Your job is to make the goal and the "done" test clear.

## Template

Markdown, these sections in this order, fits on one screen:

```markdown
# <Short title, it names the job>

## Goal
<The result the user wants, from their point of view, in one or two sentences.>
Why: <what it is for. This lets the agent settle unplanned cases on its own.>

## User's request
"<The user's words, verbatim. Do not paraphrase into jargon.>"

## Context
- Repository: <path>, base branch <branch>
- <Pages, screens, files or features involved, if known>
- <An existing example to imitate: "like the Contact page">
- <Links, screenshots, test data>

## Done when
1. <A checkable fact: a command that passes, a behaviour visible in the browser, a test that exists and passes.>
2. <...>

## Constraints
- <What to leave alone, style to follow, no new dependencies, ...>
- <Defaults you chose for open points: "If the text is not specified, use 'Send'.">
```

The script adds the delivery footer (own-the-task skill, report path, push or not). Do not write it yourself.

## Rules

- **"Done when" is the most important section.** An agent that can check its own work iterates until it gets there. Make each criterion observable: "the form shows an error when the email is empty", not "the form works well".
- **One task, one brief, one job.** Two independent changes are two jobs in parallel, not one brief.
- **No implementation steps** unless they are a real constraint. You are not the developer; your steps would be wrong and would box the agent in.
- **Calm tone.** No capitals, no "CRITICAL" or "MUST": recent models over-react to shouted instructions. State it once, plainly, and say why.
- **Concrete examples beat adjectives.** "The button looks like the one on /pricing" beats "a nice button".
- **Settle ambiguity before starting.** OpenCode cannot ask questions. If a done criterion is missing, ask the user one simple question, or pick a sensible default and write it in Constraints.
- **Bugs: reproduce first.** Describe the exact symptom (what the user does, what they see, what they expected) and ask for a test that reproduces the bug before the fix.
- **Vague or large tasks: two stages.** Start a `--plan` job first. Summarise its plan to the user in plain words, get a yes, then start the build job with the plan pasted in Context.
- **Effort.** `--effort high` for hard work (intermittent bugs, changes across many parts); default otherwise.
- **Follow-ups (`<oc> send`) restate only the gap**: "Criterion 2 is not met: on mobile the button is hidden. The rest is good, keep it as is."
- **Pull requests only on request.** Without `--push` the agent commits on its own branch and pushes nothing.

## Example 1: small UI feature

User: "can you add a button to download the invoice as PDF on the order page?"

```markdown
# Download invoice as PDF from the order page

## Goal
On an order's page, the customer can download the invoice as a PDF with one click.
Why: customers ask support for invoices by email today; this lets them get it themselves.

## User's request
"can you add a button to download the invoice as PDF on the order page?"

## Context
- Repository: /workspace/bots/<id>/shop, base branch main
- The order page is the one at /orders/<id>
- Imitate the existing "Print" button on the same page for placement and style

## Done when
1. The order page shows a "Download invoice (PDF)" button next to "Print".
2. Clicking it downloads a PDF that contains the order number, date, lines and total.
3. A test covers the PDF generation; the full test suite passes.
4. Checked in the browser on a running local copy, with a screenshot in the report.

## Constraints
- No new paid service. A PDF library is fine if the project has none.
- If the invoice layout is not specified, mirror the order page content.
```

## Example 2: bug

User: "people say they can't log in on the phone, it just reloads"

```markdown
# Fix login reloading on mobile

## Goal
Users on phones can log in again.
Why: mobile users are locked out; this blocks most customers.

## User's request
"people say they can't log in on the phone, it just reloads"

## Context
- Repository: /workspace/bots/<id>/app, base branch main
- Symptom: on a phone-sized screen, entering a valid email and password and tapping "Log in" reloads the login page instead of opening the dashboard. Desktop works.

## Done when
1. A test reproduces the bug (it fails before the fix and passes after).
2. On a phone-sized browser window, logging in with a valid account opens the dashboard.
3. Desktop login still works; the full test suite passes.
4. The report explains the cause in one plain sentence.

## Constraints
- Do not change how sessions are stored unless the cause is there; say so in the report if it is.
```

## Example 3: vague task, two stages

User: "the site is slow, can you make it faster?"

Stage 1, started with `--plan`:

```markdown
# Find why the site is slow

## Goal
A short plan of the few changes that would make the site noticeably faster for visitors.
Why: the user finds the site slow; we want the biggest wins first, not a rewrite.

## User's request
"the site is slow, can you make it faster?"

## Context
- Repository: /workspace/bots/<id>/site, base branch main

## Done when
1. Pages measured on a running local copy, with load times.
2. At most five proposed changes, each with expected gain, effort and risk, biggest gain first.
```

Then summarise the plan to the user ("three changes, the biggest one makes the home page about twice as fast"), get their choice, and start a normal job whose Goal is the chosen changes and whose Context includes the plan.
