---
name: Skill-authoring
description: Create or update a reusable skill (SKILL.md plus optional scripts/ and references/) with skill_create or skill_update. Use when a multi-step task is worth repeating or the user asks to save, write, change, or improve a skill.
---

A skill is a generic, repeatable how-to. Account names, channels, inboxes, and schedules belong in a routine, not a skill.

A skill folder holds:
- `SKILL.md`: frontmatter `name` (at most 80 characters, the /Name users type) and `description` (what it does and when to use it; it is the only part read before the skill loads), then numbered steps written as imperative, concrete commands for a future run.
- `scripts/`: code the steps run, so the procedure is never retyped. Refer to them as `scripts/<file>`.
- `references/`: long material a step reads only when needed (API notes, templates, examples).

## Create a skill

1. Pick a fresh draft folder, `skill-drafts/<name>-<short id>`, for example `skill-drafts/brew-k3f9`.
2. Write each file of the folder with write_file, which creates the folders it needs; fix a file with edit_file. A folder this conversation wrote entirely with these two tools is saved without asking the user; shell or a file from elsewhere makes the user confirm it.
3. If the skill has scripts, run each script once from the draft folder and fix what fails.
4. Save with skill_create `{ "path": "skill-drafts/<name>-<short id>" }`. A one-file skill can pass name, description, and body instead, with no draft.
5. If you used shell, delete the draft once the save succeeds: `rm -rf skill-drafts/<name>-<short id>`.
6. Mention /Name so the user can open it.

## Update a skill

To change only SKILL.md, skill_update with name plus description, body, or content is enough, with no draft.

To change other files:
1. skill_read the skill and note its `dir` (read-only).
2. Copy the whole folder with shell: `rm -rf skill-drafts/<name> && mkdir -p skill-drafts && cp -a <dir> skill-drafts/<name>`.
3. Edit the copy's files with edit_file; add new files with write_file. Run any changed script once.
4. Save with skill_update `{ "name": "<name>", "path": "skill-drafts/<name>" }`. The saved folder is replaced by the copy, so a file missing from it is deleted.
5. Once the save succeeds, delete the draft: `rm -rf skill-drafts/<name>`.
6. Mention /Name so the user can open it.

The user may have to confirm every file of a folder, so a folder holds at most 20 files, 64 KB of text and 1 MB in all. Scripts are UTF-8 text and never hold credentials. Symlinks are skipped.
