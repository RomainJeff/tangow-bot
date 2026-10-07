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

1. Start a clean draft with shell: `rm -rf skill-drafts/<name> && mkdir -p skill-drafts/<name>`.
2. Write the folder's files into `skill-drafts/<name>/` with write_file.
3. Run each script once from the draft folder and fix what fails.
4. Save with skill_create `{ "path": "skill-drafts/<name>" }`. A one-file skill can pass name, description, and body instead, with no draft.
5. Once the save succeeds, delete the draft: `rm -rf skill-drafts/<name>`.
6. Mention /Name so the user can open it.

## Update a skill

1. skill_read the skill and note its `dir` (read-only).
2. Copy the whole folder with shell: `rm -rf skill-drafts/<name> && mkdir -p skill-drafts && cp -a <dir> skill-drafts/<name>`.
3. Edit the copy's files with edit_file; add new files with write_file. Run any changed script once.
4. Save with skill_update `{ "name": "<name>", "path": "skill-drafts/<name>" }`. The saved folder is replaced by the copy, so a file missing from it is deleted.
5. Once the save succeeds, delete the draft: `rm -rf skill-drafts/<name>`.
6. Mention /Name so the user can open it.

To change only SKILL.md, skill_update with name plus description, body, or content is enough, with no draft.

The user confirms every file of a folder before it is saved, so a folder holds at most 20 files, 64 KB of text and 1 MB in all. Scripts are UTF-8 text and never hold credentials. Symlinks are skipped.
