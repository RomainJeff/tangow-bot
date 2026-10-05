---
name: pr-workflow
description: Ship a change as a reviewable pull request: branch, atomic commits, gh pr create, watch CI and fix it.
---

Follow this whenever the task ends in a pull request.

1. Start from an up-to-date default branch and create a focused branch: `git fetch origin && git switch -c <type>/<short-topic> origin/<default>`. Never commit on `main` or `master`.
2. Work in small steps. Before each commit run the repository's lint, typecheck and tests (the ones found during onboarding); commit only when they pass.
3. Commit atomically: one logical change per commit, subject in the imperative under 72 characters, body explaining why when it is not obvious. Stage by path, never `git add -A` blindly; check `git status` for generated files, secrets or `.env` first.
4. Follow the repository's rules for changelogs, docs and co-author trailers if it has them.
5. Push and open the PR with the GitHub CLI:

   ```bash
   git push -u origin HEAD
   gh pr create --fill --draft   # drop --draft when it is ready for review
   ```

   The description says what changed, why, how it was tested, and anything a reviewer should look at first. Link the issue when there is one.
6. Watch CI: `gh pr checks --watch`. On a failure read the log (`gh run view <id> --log-failed`), reproduce locally, fix with a new commit, push again. Do not retry a red check hoping it passes.
7. Address review comments with new commits rather than force-pushes unless the repository asks for a clean history. Reply to each comment with what you did.
8. Never merge, never delete branches, never push to a branch you do not own, unless explicitly told to.
