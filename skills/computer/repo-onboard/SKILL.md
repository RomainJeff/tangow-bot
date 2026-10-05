---
name: repo-onboard
description: Get productive in an unfamiliar repository: read its conventions, detect the stack, install and run the tests before changing anything.
---

Do this once when you land in a repository you have not worked in during this session.

1. Read the conventions first: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, then `README.md`. Follow what they say over any habit of yours.
2. Detect the stack from the lockfile and manifests, not from guesswork:
   - `pnpm-lock.yaml` / `package-lock.json` / `yarn.lock` → Node; use the matching package manager only.
   - `pyproject.toml` / `requirements*.txt` → Python; look for a venv or `uv`.
   - `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml`, `build.gradle` → use their standard tools.
   - A `Makefile`, `justfile` or `Taskfile` usually names the blessed commands; prefer those.
3. Find the real commands in the manifest scripts (`package.json` `scripts`, `pyproject` tool sections, `Makefile` targets): install, build, lint, typecheck, test. Note monorepo layouts (`workspaces`, `pnpm-workspace.yaml`) and how to scope a command to one package.
4. Install dependencies with the lockfile respected (`pnpm install --frozen-lockfile`, `npm ci`, `uv sync`, ...). Never upgrade or add dependencies as part of onboarding.
5. Run the test suite once before touching code and keep the result. Pre-existing failures are not yours to fix unless asked; mention them.
6. Skim the layout: entry points, where tests live and how they are named, how configuration and environment variables are loaded. Never read or print `.env` files or secrets.
7. Write down in your reply the commands you will use for lint, typecheck and tests. Use exactly those for the rest of the task.
