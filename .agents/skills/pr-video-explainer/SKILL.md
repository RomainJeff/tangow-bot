---
name: pr-video-explainer
description: Explain a GitHub PR as a narrated, animated MP4 (HyperFrames + local Kokoro TTS). Use when the user asks for a video, animated walkthrough, or visual explainer of a pull request.
---

# PR Video Explainer

PR → story.json (scenes + English voiceover) → `build.mjs` (TTS, timing, HTML) → HyperFrames check → MP4.

The template (`template/index.html`) owns the visual identity, transitions and animation. Your job is the **story**: find the one mechanism the PR changes and tell it in 6–8 scenes.

## Prereqs (one-time)

- HyperFrames CLI cached by npx: `HF=$(ls -d ~/.npm/_npx/*/node_modules/.bin/hyperframes | head -1)`. If empty, run `npx -y hyperframes --version` once. `npx hyperframes …` itself can hang: always call `$HF` directly.
- Kokoro venv: `~/.cache/hyperframes/kokoro-venv` with `kokoro-onnx soundfile` (`uv venv --python 3.12 … && uv pip install kokoro-onnx soundfile`). `build.mjs` sets `HYPERFRAMES_PYTHON` to it.
- `ffprobe` (brew ffmpeg).

If something is missing, stop and offer to install it.

## Workflow

1. **Read the PR**: `gh pr view <url> --json title,body,files,additions,deletions,commits,headRefName`, then `gh pr diff` (or `gh api repos/<o>/<r>/contents/<path>?ref=<branch> -H "Accept: application/vnd.github.raw"` for docs). Don't clone the repo.
2. **Find the mechanism.** What ran where, before vs after? Which data/control flow changed? What stays the same? What's the status/caveat? Write it in 5 sentences before touching JSON.
3. **Write `story.json`** in a directory **outside this repo** (default `~/pr-video-explainers/<repo>/pr-<num>/`; never commit videos, audio or story files here). See schema below. Typical arc:
   `title` hook → `diagram` before → `diagram` after → `diagram` zooms on the key protocol (with `msg` pills) → `kinetic` invariants/edge cases → `number` status (final).
4. **Build**: `node .agents/skills/pr-video-explainer/scripts/build.mjs <dir>`. TTS per scene is cached by text hash, so only edited scenes are re-voiced.
5. **Check**: in `<dir>`, `$HF lint` and `$HF check`. 0 errors is the bar. Known OK noise: `timeline_track_too_dense`, contrast on `.ghost` watermark, `content_overlap` info during crossfades.
6. **Look**: `$HF snapshot --at <t0+dur*.85 per scene> --no-end -o /tmp/<x> --describe false`, read `contact-sheet.jpg`. Fix overlaps, clipped labels, empty scenes by editing coordinates in story.json and rebuilding.
7. **Render**: `$HF render -o pr-<num>.mp4`, then `open` it for the user. Offer `/publish-site`; never publish without explicit consent.

## Language: always English

**Voiceover and on-screen text are always in English**, whatever the conversation language or the PR's language. Translate French PR descriptions/docs. Use an English Kokoro voice (`am_michael` default; `af_heart`, `bm_george`, `bf_emma` also fine). Never use `ff_siwis` or other non-English voices unless the user explicitly asks for another language for that video.

## Format: motion video, never slides

This is a motion graphic, not a deck. Always:

- **Big text only.** Nothing on screen below 28 px (template minimum). Headings 76 px, kinetic lines 132 px, title 168 px.
- **≤ ~6 words on screen at a time.** The voice carries the detail; the screen carries one word-level idea.
- **Show, don't list.** Explain with diagrams, moving `msg` pills, focus/glow, count-ups. No bullet lists, no code blocks, no paragraphs, no captions.
- Every scene moves: something enters, travels, lights up or counts while the voice speaks.
- Heading = short claim with one `*accent*` word ("The worker *never* holds a key").

## Voiceover rules

- English, spoken register, one idea per scene, 1–3 sentences (≈ 8–12 s). Spell numbers that TTS mangles ("two oh three").
- The voice tells the *why*, the screen shows the *what*. Don't read the on-screen labels aloud.
- Short spoken sentences (< ~110 chars).
- Total target 60–90 s. Use `"speed": 1.1` at story level to tighten.

## story.json schema

```jsonc
{
  "pr": { "repo": "rakazo-bot", "num": 203, "url": "…" },
  "voice": "am_michael",        // English Kokoro voice (default)
  "speed": 1.0, "lead": 0.6, "tail": 0.7, "xfade": 0.5,  // optional timing (s)
  "scenes": [ /* each: type, ghost (watermark word), vo, min? (min seconds) */ ]
}
```

`*word*` in any heading/title/line/label renders as accent italic with a drawn underline. Words reveal one by one.

| type | fields |
|---|---|
| `title` | `kicker` (small mono), `title` (≤ 6 words) |
| `kinetic` | `lines[]` (string or `{t, tone: ok\|fail\|muted}`, ≤ 5 words each, max 3–4), `at[]` (voice fraction per line), `size?` (px, default 132). Previous lines dim as the next enters. |
| `number` | `value`, `of` or `suffix`, `label`, `foot?`, `at[]`. Progress ring + count-up. Good final scene. |
| `diagram` | `heading`, `zones[]`, `nodes{}`, `edges_def{}`, `edges[]?` (default all), `beats[]` |

Last scene gets the fade-out automatically.

### Diagram

Coordinates are frame pixels (1920×1080). Usable area: y 300–960 (heading above), x 110–1810.

- `zones`: `{id,x,y,w,h,label}` dashed boundary (process, VM, network).
- `nodes`: `id → {x,y,label,sub?,kind?,size?}`; x/y = centre. `kind`: `card` 380×140 (default), `store` 400×150 (DB/volume), `actor` 300×120 pill (user, LLM, external). Labels 38 px mono (~23 px/char): keep labels ≤ 14 chars, else `size:[w,h]`. No `sub` paragraphs: one or two words max.
- `edges_def`: `id → [from, to, label?]`; `edges`: which to draw. Lines are clipped to box borders automatically.
- `beats`: timed on the voiceover, `at` = fraction 0–1 of the narration.
  - `focus`: node id or list → glow + bump. `tone`: `active` (amber, default) | `ok` | `fail`; ok/fail stay lit.
  - `pulse`: edge ids → a dot travels along the edge; `back`: subset traveling in reverse.
  - `msg`: `{edgeId: "text"}` → a labelled pill travels along the edge (the request/answer itself). Prefer this over static labels. 1–2 words.
  - `sub`: `{nodeId: "new subtext"}` swaps a node's subline.
  - `tag`: `"text"` or `["text", tone]`, pinned above the first focused node; `tagAt: [dx, dy]` to move it (`[0, 90]` = below).

Layout tips: keep ≥ 60 px between nodes; horizontal flows read best; max ~5 nodes per diagram; re-declare nodes per scene (positions differ per scene).

## Files

- `template/index.html`: composition (palette, fonts Newsreader + JetBrains Mono, scene builders). Edit it for style changes, never the generated `index.html`.
- `scripts/build.mjs`: story.json → `assets/vo-*.wav` + `index.html` + `hyperframes.json`.
- Example: `example/story.json` (PR #203).
