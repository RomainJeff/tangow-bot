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
6. Delete `skill-drafts/<name>/` once the save succeeds.
7. To change a saved skill, copy its `dir` from skill_read into `skill-drafts/<name>/`, edit it, save with skill_update `{ "name": "<name>", "path": "skill-drafts/<name>" }`, then delete the draft.
8. Mention /Name so the user can open it.

Limits: 200 files and folders, 10 MB per skill. Symlinks are skipped. skill_update without path changes SKILL.md only.
