# Managed skills

Skills versioned in this repository, shipped with the `app` image and mounted read-only in every
Docker computer under `/managed-skills`. They add to the skills a user writes and installs from
marketplaces. Each skill is a directory with a `SKILL.md` (frontmatter `name` + `description`,
then the body) and optional `scripts/` and `references/`.

The family name says who reads the skill.

| Family | Directory | Reader | At runtime |
| --- | --- | --- | --- |
| `agent` | `skills/agent/<dir>/` | The bot's harness (Pi, in the worker) | Listed in the prompt catalog as `builtin:<name>`, body loaded with `skill_read`. Files under `/managed-skills/agent/<dir>/` for Pi's `shell` tool. Not wired to coding agents. |
| `computer` | `skills/computer/<dir>/` | Coding agents running on the computer (OpenCode today) | `/managed-skills/computer` symlinked into the coding agent's global skills directory. Absent from Pi's catalog. |

Where a new skill goes: if it guides **the bot** (how to talk to the user, delegate, use its Rakazo
tools), it is an `agent` skill. If it guides **a coding agent inside a repository** (tests, PRs,
debugging), it is a `computer` skill.

Rules for `agent` skills:

- The directory name must be the skill's key, `skillDirName(name)` (lower-cased, URL-encoded);
  a skill whose directory does not match is ignored with a warning.
- The `name` in the frontmatter is the id users see (`builtin:<name>`); renaming it loses the
  per-bot visibility settings attached to the old id.
- Keep the family small: every `agent` skill costs one catalog line on every turn of every bot.
