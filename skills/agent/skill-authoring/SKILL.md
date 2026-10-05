---
name: Skill-authoring
description: Write a reusable skill (SKILL.md plus optional scripts/ and references/) and save it with skill_create. Use when a multi-step task is worth repeating or the user asks to save, write, or improve a skill.
---

1. Check it is a skill: a generic, repeatable how-to. Account names, channels, inboxes, and schedules belong in a routine, not a skill.
2. Draft the folder in your workspace at `skill-drafts/<name>/`:
   - `SKILL.md`: frontmatter `name` (at most 80 characters, the /Name users type) and `description` (what it does and when to use it; it is the only part read before the skill loads), then numbered steps.
   - `scripts/`: code the steps run, so the procedure is never retyped. Refer to them as `scripts/<file>`.
   - `references/`: long material a step reads only when needed (API notes, templates, examples).
3. Write the steps as instructions to a future run: imperative, concrete commands, nothing the reader already knows.
4. Run each script once from the draft folder and fix what fails.
5. Save with skill_create `{ "path": "skill-drafts/<name>" }`. A one-file skill can pass name, description, and body instead.
6. Once the save succeeds, delete the draft with shell: `rm -rf skill-drafts/<name>`.
7. To change a saved skill, edit a full copy so its scripts and references are kept:
   - skill_read the skill and note its `dir`.
   - Copy it with shell: `mkdir -p skill-drafts && cp -a <dir> skill-drafts/<name>`. The copy is writable; `<dir>` is read-only.
   - Edit the copy with write_file or shell.
   - Save with skill_update `{ "name": "<name>", "path": "skill-drafts/<name>" }`. The saved folder is replaced by the copy, so a file missing from it is deleted.
   - Delete the draft: `rm -rf skill-drafts/<name>`.
8. Mention /Name so the user can open it.

Limits: 200 files and folders, 10 MB per skill. Symlinks are skipped. skill_update without path changes SKILL.md only.
