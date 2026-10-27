# Managed skills

Skills versioned here are managed skills. They are always enabled and cannot be disabled per bot.
Each directory contains SKILL.md with frontmatter `name` and `description`, plus optional `scripts/`
and `references/`.

| Family | Directory | Reader | Runtime |
| --- | --- | --- | --- |
| `agent` | `skills/agent/<dir>/` | Bot harness | Baked root-owned and read-only at `/managed-skills/agent` in worker templates; also mounted at that path in Docker computers. |
| `computer` | `skills/computer/<dir>/` | Coding agents on the computer | Computer only: read-only `/managed-skills/computer` mount and OpenCode startup link at `~/.config/opencode/skills`. |

Put bot workflow guidance in `agent`. Put repository coding guidance in `computer`. Managed agent
skill directory names must equal `skillDirName(name)`, the normalized URL-encoded name. Keep the
family small because every skill adds a catalog line on every run. Existing `builtin:` ids remain
stable for clients; they do not allow per-bot disable settings to hide managed skills.

Workers converge three sources into `~/.agents/skills/`, one symlink per name:

1. Managed skills at `/managed-skills/agent`.
2. Bot skills at `/workspace/bots/<botId>/skills/`, on the private volume.
3. Shared skills at `/workspace/shared/skills/`, on the space's shared volume.

The first source wins a name collision. The guest logs it and reports it to the controller.
Location decides visibility for volume skills; there are no per-bot switches. Native file tools
write skills in their source folder, and the next run rebuilds the links and catalog. The runner
requires an explicit VM home and only replaces links in its own ownership record. It refuses to
replace user directories or unowned entries.

Pi loads only that folder with pi-coding-agent's `loadSkills`, defaults off, through an explicit
ResourceLoader. Its SDK catalog replaces the controller catalog in worker prompts. Native `read`
loads SKILL.md and native `bash` executes scripts.

At run end, a bounded file report updates the controller's DB index and skills screen. The
controller refuses to index reported skills containing a known run secret, including in scripts;
it leaves volume files untouched. Linked, binary or oversized bundles are not indexed. The
[handoff](../docs/implementation/pi-e2b/P3-handoff.md#s8-skills-on-volumes) documents bounds, session
limits, migration and computer convergence limitations.

Existing user skills can be copied, without deleting originals, by
`scripts/migrate-skills-to-volumes.ts --space <space-id>`. Stop writers first. Conflicting targets
are refused and identical copies are unchanged on retry. All migrated skills go to shared/skills
so every bot in the space retains them. Marketplace files are outside this migration. On Docker,
the home move (`scripts/migrate-docker-homes.ts`, then each sleep) makes the same copy once per
space, after the space's team home has moved.

## Coding work by environment

Worker native file tools and `bash` operate on `/workspace/bots/<botId>` and
`/workspace/shared`. Apps, browser and computer-local services use Rakazo computer
and browser tools; commands use `computer_exec`. Harnesses expose Rakazo tools
under their own naming.

OpenCode is installed on the computer image for terminal use. It loads computer
skills, while the worker loads agent skills.
