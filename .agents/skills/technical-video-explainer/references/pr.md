# PR angle

The video answers: **what does this PR change, and why does it matter?** The viewer knows the system; show them the delta.

## Read

`gh pr view <url> --json title,body,files,additions,deletions,commits,headRefName`, then `gh pr diff` (or `gh api repos/<o>/<r>/contents/<path>?ref=<branch> -H "Accept: application/vnd.github.raw"` for docs). Don't clone the repo.

## Find the mechanism

Answer before writing scenes:

- What ran where, before vs after?
- Which data or control flow changed?
- What stays the same?
- What's the status or caveat (behind a flag, partial, follow-up pending)?

The video is about the one mechanism the PR changes, not the file list. Ignore renames, tests and plumbing unless they are the point.

## Arc

`title` hook → `diagram` before → `diagram` after → `diagram` zooms on the key protocol (with `msg` pills) → `kinetic` invariants/edge cases → `number` status (final).

Before and after diagrams reuse the same node positions where possible, so the change reads as movement, not as a new picture.

## Naming

- Slug: `pr-<num>`; directory `~/technical-video-explainers/<repo>/pr-<num>/`.
- `source`: `{ "kind": "pr", "ref": "<repo>#<num>", "url": "<pr url>" }`.
- Title kicker: `<repo> · PR #<num>`.

Example: `example/pr-story.json`.
