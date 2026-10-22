# Plan / architecture angle

The video answers: **what are we building (or what is built), and why is it shaped this way?** The viewer may not know the system; give them the mental model first, then the decisions.

Two flavours, same arc:

- **Plan**: a future change (implementation plan, RFC, design doc, HTML plan). Tense is "will". End on what ships first.
- **Architecture**: an existing system. Tense is "does". End on the property that holds the design together.

## Read

- Plan file (Markdown, HTML plan, doc URL): read it whole. Note the goal, the components it adds or moves, the sequencing, and the decisions with their rejected alternatives.
- Architecture: start from the entry points and the boundaries (processes, services, stores, external providers). Read code only to confirm a flow, not to inventory files. A short Explore pass is fine for a large repo.
- If the plan names open questions, keep at most one in the video, framed as open.

## Find the model

Answer before writing scenes:

- What problem does it solve, in one sentence a newcomer understands?
- What are the 3–5 parts, and where are the boundaries (process, VM, network, trust)?
- What is the main flow through them, end to end?
- Which one or two decisions shape everything else, and what was the alternative?
- What is the invariant or guarantee the design protects?
- Plan only: what is the order of delivery, and what is first?

Pick the main flow and one decision. A plan with ten steps still makes one video about its spine.

## Arc

`title` hook (the problem) → `diagram` the parts at rest (zones = boundaries) → `diagram` the main flow (`pulse` / `msg` along edges) → `diagram` or `kinetic` the key decision vs its alternative (alternative in `muted` or `fail`) → `kinetic` invariants → final scene:

- Plan: `number` for the phases (`value` = phases, `label` = what ships first) or `kinetic` with the sequence.
- Architecture: `kinetic` with the guarantee, or `number` for a defining figure.

Keep the same node positions across the parts and flow scenes, so the flow plays on the picture the viewer just learned.

## Naming

- Slug: short kebab name of the plan or system (`pi-e2b-workers`, `session-log`); directory `~/technical-video-explainers/<repo>/<slug>/`.
- `source`: `{ "kind": "plan" | "architecture", "ref": "<file path, doc title or system name>", "url"?: "<link if public>" }`. Never put a local absolute path in on-screen text.
- Title kicker: `<repo> · Plan` or `<repo> · Architecture`.

Examples: `example/plan-story.json` (plan), `example/architecture-story.json` (architecture).
