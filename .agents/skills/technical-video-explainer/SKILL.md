---
name: technical-video-explainer
description: Explain a pull request, a plan or an architecture as a narrated, animated MP4. Use when the user asks for a video, animated walkthrough, or visual explainer of a PR, an implementation plan, an RFC, a design doc or how a system is built.
---

# Technical Video Explainer

Source → story.json (scenes + English voiceover) → `build.mjs` (TTS, timing, HTML) → HyperFrames check → MP4.

The template (`template/index.html`) owns the visual identity, transitions and animation. Your job is the **story**: find the one idea worth explaining and tell it in 6–8 scenes.

## Pick the angle, then read only its reference

| Angle | Source | Read |
|---|---|---|
| **PR** | a GitHub pull request (URL or number): what changed and why | `references/pr.md` |
| **Plan / architecture** | a plan, RFC, design doc, HTML plan, or a system in the codebase: what we will build, or how it is built | `references/plan.md` |

If the request is ambiguous (e.g. "explain this" next to both a PR and a plan), ask which angle. The angle reference tells you how to read the source, find the core idea, and which scene arc fits. Everything below is shared.

## Prereqs (one-time)

- HyperFrames CLI cached by npx: `HF=$(ls -d ~/.npm/_npx/*/node_modules/.bin/hyperframes | head -1)`. If empty, run `npx -y hyperframes --version` once. `npx hyperframes …` itself can hang: always call `$HF` directly.
- Kokoro venv: `~/.cache/hyperframes/kokoro-venv` with `kokoro-onnx soundfile` (`uv venv --python 3.12 … && uv pip install kokoro-onnx soundfile`). `build.mjs` sets `HYPERFRAMES_PYTHON` to it.
- `ffprobe` (brew ffmpeg).

If something is missing, stop and offer to install it.

## Workflow

1. **Read the source and find the core idea**, following the angle reference. Write it in 5 sentences before touching JSON.
2. **Write `story.json`** in a directory **outside this repo** (`~/technical-video-explainers/<repo>/<slug>/`, slug given by the angle reference; never commit videos, audio or story files here). Schema: `references/story-schema.md`.
3. **Build**: `node .agents/skills/technical-video-explainer/scripts/build.mjs <dir>`. TTS per scene is cached by text hash, so only edited scenes are re-voiced.
4. **Check**: in `<dir>`, `$HF lint` and `$HF check`. 0 errors is the bar. Known OK noise: `timeline_track_too_dense`, `content_overlap` info during crossfades.
5. **Look**: `$HF snapshot --at <t0+dur*.85 per scene> --no-end -o /tmp/<x> --describe false`, read `contact-sheet.jpg`. Fix overlaps, clipped labels, empty scenes by editing coordinates in story.json and rebuilding.
6. **Render**: `$HF render -o <slug>.mp4`, then `open` it for the user. Offer `/publish-site`; never publish without explicit consent.

## Language: always English

**Voiceover and on-screen text are always in English**, whatever the conversation language or the source's language. Translate French sources. Use an English Kokoro voice (`af_heart` default: the female voices sound clearly better; `bf_emma` also fine, `am_michael` or `bm_george` only on request). Never use `ff_siwis` or other non-English voices unless the user explicitly asks for another language for that video.

## Format: motion video, never slides

This is a motion graphic, not a deck. Always:

- **Big text only.** Nothing on screen below 28 px (template minimum). Headings 76 px, kinetic lines 132 px, title 168 px.
- **≤ ~6 words on screen at a time.** The voice carries the detail; the screen carries one word-level idea.
- **Show, don't list.** Explain with diagrams, moving `msg` pills, focus/glow, count-ups. No bullet lists, no code blocks, no paragraphs, no captions.
- Every scene moves: something enters, travels, lights up or counts while the voice speaks.
- **Clean look:** white background, black/grey ink, one blue accent. Accent only on the one word that carries the claim (`*word*`), at most 1–2 per scene. Red (`fail`) only for a real problem. Never accent for decoration.
- Heading = short claim with one `*accent*` word ("The worker *never* holds a key").

## Voiceover rules

- English, spoken register, one idea per scene, 1–3 sentences (≈ 8–12 s). Spell numbers that TTS mangles ("two oh three").
- The voice tells the *why*, the screen shows the *what*. Don't read the on-screen labels aloud.
- Short spoken sentences (< ~110 chars).
- Total target 60–90 s. Use `"speed": 1.1` at story level to tighten.

## Files

- `references/pr.md`, `references/plan.md`: per-angle reading, core idea, scene arc.
- `references/story-schema.md`: story.json fields, scene types, diagram coordinates and beats.
- `template/index.html`: composition (white monochrome palette + one accent, fonts Inter + JetBrains Mono, scene builders). Edit it for style changes, never the generated `index.html`.
- `scripts/build.mjs`: story.json → `assets/vo-*.wav` + `index.html` + `hyperframes.json`.
- Examples (~40 s each): `example/pr-story.json` (PR #258), `example/plan-story.json` (check-in nudge plan), `example/architecture-story.json` (computer runtime).
