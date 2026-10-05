---
name: pr-motion-explainer
description: Build a short motion-graphic explainer (dark diagram, nodes, travelling pulses, before/after toggle) of the one mechanism a pull request changes. Use alongside every code review of a non-trivial Rakazo PR ("review PR #52", "code review this branch", "/code-review"), and whenever someone asks for a "motion explainer" or an animated explainer of a PR. Skips trivial PRs.
---

# PR motion explainer

One self-contained HTML file per non-trivial PR: a 16:9 diagram where the mechanism the PR touches plays out step by step, with a toggle between **before** and **after**. The reviewer watches 20 seconds and knows what changed before reading the diff. Start from [template.html](template.html); you only write its CONTENT block.

Reference build: [examples/pr-49-home-check.html](examples/pr-49-home-check.html) (supervisor home check, 5 steps per mode). Read it before your first build.

## 1. Gate: is the PR worth it?

Skip, and say so in one line, when the PR has no behaviour to animate: docs, plans, skills or prompts only, CHANGELOG, dependency bumps, formatting, renames, CI config, or under ~20 changed lines of logic. When unsure, build it: a weak explainer costs 10 minutes, a missing one costs the reviewer a cold read.

## 2. Review first, explainer second

The review is the deliverable. Do it and deliver it. Build the explainer in parallel with a background subagent given the PR number and this skill's path, so exploring the diff does not crowd the review context. The explainer never replaces or delays findings.

If the review finds a blocking bug, add a third mode named `bug` that plays the failure scenario (inputs → wrong state). That is the most useful frame in the file.

## 3. Find the mechanism

Answer these before touching the template:

- **What runs?** The 3–7 actors involved (functions, files, processes, services, the user). These become nodes.
- **What differs?** The first step where after diverges from before. Everything before it is shared setup and must be identical in both modes, so the toggle reveals exactly the divergence.
- **What would a user notice?** End each mode on it (bot silent / bot answers, port held / port free).
- **No "before"?** For a new feature, use modes `{without, with}` or a single `{flow}` mode. Mode names are free; the toggle is built from the keys of `MODES`.

## 4. Fill the CONTENT block

Copy `template.html` to `.tmp/pr-motion-explainers/pr-<n>-<slug>.html` at the repository root. `.tmp` is git-ignored: explainers are review aids, never committed. Edit only the CONTENT block.

| Field | Rule |
|---|---|
| `PR.title` | The mechanism, lower case, ≤ 60 chars. Not the PR title. |
| `NODES` | 3–7. `kind`: `card` (function, file, service), `chip` (a flag, timer or rule), `orb` (a running process or actor). Lay out on a grid in the 1600×900 viewBox: rows at y≈310 / 630 / 800, columns at x≈250 / 800 / 1330. Keep y < 150 empty (header). `show:false` for nodes that appear in one mode only. |
| `EDGES` | Only the flows a step actually pulses. Same row or same column whenever possible: diagonal edges cross nodes. |
| Steps | 4–7 per mode. Each step patches state: `nodes:{id:{sub,tone,show,tag}}`, `edges:{id:tone}`, `pulse:[edgeIds]`, `dur` (1.3–1.5 on the key beat and the last step). |
| `tone` | `active` = working now, `fail` = broken, `ok` = fixed or healthy, `ghost` = present but irrelevant, `idle` = reset. Reset the previous step's `active` nodes to `idle` so only the current actor glows. |
| `tag` | One callout at a time: the rule or fact that matters (`"rule: mode has w"`). `[text,"fail"|"ok"]` to colour it, `null` to remove. |
| `say` | One plain sentence a non-engineer understands. No identifiers. |
| `tech` | Real names from the diff: `file → function`, constants, modes, flags. Every value must exist in the code; never invent a number. |

## 5. Verify

```bash
node .agents/skills/pr-motion-explainer/scripts/snap.mjs <file.html> .tmp/pr-motion-explainers/snaps
```

It needs Playwright (local or global install; set `CHROMIUM_PATH` to use a system Chromium). It screenshots every step of every mode in dark mode (`SCHEME=light` for the other), and reports console errors, overlapping nodes or tags on the last step, and horizontal scroll at 375 px. Then **read** at least the divergence step and the last step of each mode. Fix and rerun until:

- [ ] no errors, no overlaps, no horizontal scroll
- [ ] no edge runs through a node, no tag leaves the stage
- [ ] shared steps are word-for-word identical across modes
- [ ] each `tech` line checked against the diff

## 6. Deliver

- In the review reply, one line with the explainer's path. Share it as a file or a private page only if the person asks.
- Never commit it and never post it on the PR: GitHub comments cannot embed it.

## Pitfalls

- The motion is a claim about the code. A pretty animation of the wrong mechanism is worse than none: build it from the diff, not the PR description.
- More than 7 nodes means you are animating the system, not the change. Cut.
- Keep the template's engine untouched. If a PR truly needs a new primitive, add it to `template.html` and the reference build in the same change.
