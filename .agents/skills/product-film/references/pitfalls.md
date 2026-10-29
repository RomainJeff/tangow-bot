# Technical pitfalls

Each of these cost a render or a wrong diagnosis.

## Screens on the glass (HTML-in-canvas)

- The source canvas must be **painted** for `drawElementImage` to capture it: hide it behind the opaque 3D canvas with
  `z-index: -1`, never `opacity: 0` (it then captures nothing).
- Capture in `onpaint` after `requestPaint()`: update the DOM, ask for a paint, draw the element into the canvas, then
  render the 3D frame.
- Capture resolution follows the render's pixel ratio: 3 px per point at 1080p, 6 at 4K (`--resolution 4k` renders at
  DPR 2). The engine sets the canvas size from `devicePixelRatio`; a fixed 1206 × 2622 canvas is blurry in 4K.
- Show the right screen from time inside `render(t)`, never with `tl.set(display)`: seek order reverts sets.
- Measuring positions seeks the timeline; do it in "measuring" mode (layout only, no capture, no 3D render) or the
  render times out (`Runtime.evaluate timed out`).
- In a bottom-aligned thread, collapsed items (`height: 0`) need `flex-shrink: 0` on the thread's children, or cards get
  squashed when content above grows.

## 3D

- Camera and lights live in the hero pose's frame (`toWorld`), so the phone's turns read on screen.
- `camera.up`: world up for object shots, the phone's +Y for UI shots (the engine blends with `cam.ui`). Locking to the
  phone's up on wide shots tilts the room and the phone reads as leaning toward the viewer.
- The cover glass needs its own environment map (an equirect "room": dim ceiling, lit floor, a softbox). With only the
  light cards in `scene.environment`, a black screen reflects nothing and reads as a dead slab. Scale its intensity with
  the key light.
- A RectAreaLight casts no shadow; use a SpotLight or DirectionalLight for any shadow you need.
- NeutralToneMapping keeps UI whites and brand colours true; ACES washes them out.

## Rendering (HyperFrames CLI)

- `snapshot --at` reads only `index.html`: snapshot another composition with `scripts/snapshot.sh`.
- `hyperframes check` reports `missing_timeline_registry` (the timeline is registered from the film's module, which
  the static check does not read) and `negative_z_index` (the capture canvas, on purpose). Both are expected; renders
  pass. Fix anything else it reports.
- Pin package versions and load them locally (`node_modules`): CDN fetches time out during renders.
- Register the timeline from the film's JS with `(window.__timelines ||= {})["main"] = tl`, so the page also runs
  outside the renderer (browser debugging). Registering it from an inline promise froze frames.
- Draft renders (`--quality draft`) show H.264 blocks in dark gradients that look like ghost text when lifted; check a
  lossless snapshot before chasing them. Delivery quality removes them.
- A render can fail without a message when its output is filtered: keep the full log (`> render.log 2>&1`).
- Times: 33 s at 1080p30 draft ≈ 7–9 min; 1080p60 delivery ≈ 20 min; 4K60 delivery ≈ 60 min (one worker, GPU).
- The CLI lowers audio to stay under −1 dBTP; leave headroom in the music edit.

## Assets and licences

- Never commit licensed media to this repository (music, photos). The Pixabay licence forbids redistributing a track on
  its own; keep media in the film project and write a CREDITS.txt next to them.
- Image generation (fal) failed on every model during the tangow film; plan for a licensed photo (Unsplash) instead.
- Downloading media needs the user's go: name the file, the source and the size first.
