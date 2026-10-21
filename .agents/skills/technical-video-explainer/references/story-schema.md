# story.json schema

```jsonc
{
  "source": { "kind": "pr" | "plan" | "architecture", "ref": "…", "url": "…" },  // metadata only
  "voice": "af_heart",          // English Kokoro voice (default)
  "speed": 1.0, "lead": 0.6, "tail": 0.7, "xfade": 0.5,  // optional timing (s)
  "scenes": [ /* each: type, vo, min? (min seconds) */ ]
}
```

`*word*` in any heading/title/line/label renders in the accent colour. Words reveal one by one.

| type | fields |
|---|---|
| `title` | `kicker` (small mono), `title` (≤ 6 words) |
| `kinetic` | `lines[]` (string or `{t, tone: ok\|fail\|muted}`, ≤ 5 words each, max 3–4), `at[]` (voice fraction per line), `size?` (px, default 132). Previous lines dim as the next enters. |
| `number` | `value`, `of` or `suffix`, `label`, `foot?`, `at[]`. Progress ring + count-up. Good final scene. |
| `diagram` | `heading`, `zones[]`, `nodes{}`, `edges_def{}`, `edges[]?` (default all), `beats[]` |

Last scene gets the fade-out automatically.

## Diagram

Coordinates are frame pixels (1920×1080). Usable area: y 300–960 (heading above), x 110–1810.

- `zones`: `{id,x,y,w,h,label}` dashed boundary (process, VM, network).
- `nodes`: `id → {x,y,label,sub?,kind?,size?}`; x/y = centre. `kind`: `card` 380×140 (default), `store` 400×150 (DB/volume), `actor` 300×120 pill (user, LLM, external). Labels 38 px mono (~23 px/char): keep labels ≤ 14 chars, else `size:[w,h]`. No `sub` paragraphs: one or two words max.
- `edges_def`: `id → [from, to, label?]`; `edges`: which to draw. Lines are clipped to box borders automatically.
- `beats`: timed on the voiceover, `at` = fraction 0–1 of the narration.
  - `focus`: node id or list → glow + bump. `tone`: `active` (ink, default) | `ok` (ink, stays lit) | `fail` (red, stays lit).
  - `pulse`: edge ids → a dot travels along the edge; `back`: subset traveling in reverse.
  - `msg`: `{edgeId: "text"}` → a labelled pill travels along the edge (the request/answer itself). Prefer this over static labels. 1–2 words.
  - `sub`: `{nodeId: "new subtext"}` swaps a node's subline.
  - `tag`: `"text"` or `["text", tone]`, pinned above the first focused node; `tagAt: [dx, dy]` to move it (`[0, 90]` = below).

Layout tips: keep ≥ 60 px between nodes; horizontal flows read best; max ~5 nodes per diagram; re-declare nodes per scene (positions differ per scene).
