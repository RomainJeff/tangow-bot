# Design system: Material and layout

Part of the [design system](../design-system.md).

Glass, the ambient light, the scroll edge and where each surface sits. Colour slots and elevations are in [Tokens](tokens.md).

## Material

Content stays opaque. Navigation and controls take a material instead: a
translucent fill that blurs the ambient light and the thread under it, with a
hairline and an inner highlight. A material is not an elevation and never
carries content: no bubble, card or panel is glass.

| Material | Light | Dark | Blur | Use |
| --- | --- | --- | --- | --- |
| `chrome` | `rgba(255, 255, 255, 0.68)` | `rgba(36, 36, 40, 0.55)` | 30 px, saturate 160% | the sidebar |
| `control` | `rgba(255, 255, 255, 0.6)` | `rgba(44, 44, 48, 0.6)` | 12 px, saturate 170% | the header's action capsule, the composer, the hover pill, round buttons |
| `menu` | `rgba(255, 255, 255, 0.8)` | `rgba(44, 44, 48, 0.8)` | 30 px, saturate 180% | small menus, tooltips: a step more opaque, to stay legible over thread text |
| `list` | `rgba(250, 250, 251, 0.94)` | `rgba(40, 40, 44, 0.94)` | 40 px, saturate 180% | dense lists: the ⌘K palette, the bot drawer at phone width |

| Material | Edge, light | Edge, dark |
| --- | --- | --- |
| `chrome` | `inset 0 1px 0 rgba(255, 255, 255, 0.7), 0 0 0 1px rgba(0, 0, 0, 0.07), 0 2px 8px -2px rgba(0, 0, 0, 0.08)` | `inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 0 0 1px rgba(255, 255, 255, 0.07), 0 2px 8px -2px rgba(0, 0, 0, 0.4)` |
| `control` | `inset 0 1px 0 rgba(255, 255, 255, 0.7), 0 0 0 1px rgba(0, 0, 0, 0.08), 0 2px 8px -2px rgba(0, 0, 0, 0.1)` | `inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 0 0 1px rgba(255, 255, 255, 0.08), 0 2px 8px -2px rgba(0, 0, 0, 0.5)` |
| `menu`, `list` | `inset 0 1px 0 rgba(255, 255, 255, 0.8), 0 0 0 1px rgba(0, 0, 0, 0.08), 0 12px 32px -8px rgba(0, 0, 0, 0.22)` | `inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 0 0 1px rgba(255, 255, 255, 0.09), 0 16px 40px -10px rgba(0, 0, 0, 0.7)` |

Under Reduce Transparency every material turns opaque: `chrome` takes
`sidebar`, the others take `card`. The ambient light stays.

The values live in `packages/ui-tokens/src/materials.ts` and reach CSS as
`--material-<name>-*`, `--ambient` (phone width included),
`--scroll-edge-blur`, `--thread-fade-*` and `--thread-under-composer`. Screens
spend them through `rk-glass-chrome`, `rk-glass-control`, `rk-glass-menu`,
`rk-glass-list`, `rk-scroll-edge`, `rk-thread-mask` and `rk-thread-overlap`
from `packages/ui-web/src/materials.css`.

Panels and overlay windows are content a person reads and edits, so they are
opaque planes, as are the parts inside a card:

| Plane | Light | Dark | Use |
| --- | --- | --- | --- |
| `sheet` | `#F5F5F7`; `0 0 0 1px rgba(0, 0, 0, 0.07), 0 2px 8px -2px rgba(0, 0, 0, 0.08), 0 24px 48px -24px rgba(0, 0, 0, 0.22)` | `#232326`; `0 0 0 1px rgba(255, 255, 255, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 24px 48px -20px rgba(0, 0, 0, 0.7)` | the side panel, the settings and Customize windows |
| `group` | `#FFFFFF`; `0 0 0 1px rgba(0, 0, 0, 0.05)` | `#333336`; `0 0 0 1px rgba(255, 255, 255, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.04)` | a settings group on a sheet |
| `well` | `#EEEEF1` | `#4E4E50` [white 9% on `surface`] | reading matter and fields inside a decision card; file and computer icons |

## Ambient

A neutral grey light falls from the top start corner over the whole window,
under the floating sidebar too, so the glass has something to blur. It has no
tint.

| | Light | Dark |
| --- | --- | --- |
| Desktop | `radial-gradient(120% 90% at 0% 0%, #FFFFFF 0%, rgba(255, 255, 255, 0) 62%), linear-gradient(160deg, #F6F6F8 0%, #E8E8EC 100%)` | `radial-gradient(110% 85% at 34% 0%, #303035 0%, rgba(48, 48, 53, 0) 62%), linear-gradient(165deg, #1E1E21 0%, #0D0D0E 100%)` |
| iPhone | `radial-gradient(130% 62% at 0% 0%, #FFFFFF 0%, rgba(255, 255, 255, 0) 100%), linear-gradient(165deg, #F3F3F5 0%, #E2E2E7 100%)` | `radial-gradient(130% 62% at 0% 0%, #36363C 0%, rgba(54, 54, 60, 0) 100%), linear-gradient(165deg, #19191C 0%, #0C0C0D 100%)` |

Dark desktop puts the light at 34% of the width, so it falls on the thread
rather than under the sidebar. iPhone has its own values, higher and from the
corner. At phone width the web adds a fade into the page background over the
bottom 22%, since Safari paints its toolbar in that colour. Don't: darken the
dark gradients further (their steps are already near the edge of perception),
or reuse the desktop values on iPhone.

## Scroll edge

Content passing under the header fades out instead of meeting a band.

- Web: a 64 px layer at the top of the thread, blurred 20 px and masked at
  55%. Beside the sidebar it only blurs: a tint would stop at the column's
  edge against the ambient light. At phone width it also takes the page
  background at 0.96, 0.85 then 0, the colour Safari paints its status bar,
  so the two meet without a line. The thread is masked: transparent to 60 px
  and opaque from 84 px, so a dark bubble leaves no smear under the title.
- Web composer: the thread runs 80 px under it (its 12 top inset, 48 bar and
  20 bottom gap) and fades across the bar, opaque 68 px above the window's
  edge and gone 20 px above it, so the glass blurs the thread and nothing
  shows in the gap below.
- iPhone: the navigation bar's native scroll-edge effect. Where it is not
  available, a 124 px layer of the page tone (light `rgb(245, 245, 247)`,
  dark `rgb(20, 20, 22)`) at 0.55, 0.30 then 0, blurred 12 px, and a thread
  mask transparent to 60 px, opaque from 124 px, fading between 100 and 28 px
  above the bottom.

Do: strengthen the edge until the title stays legible over a user bubble
passing under it.

## Layout

- Sidebar: floats 8 from the window's top, bottom and start edges, 264 wide in
  the 280 `sidebar` column, radius 18, on `chrome`. Its rows are `rounded-row`.
- Header: no band. The avatar and the name sit on the ambient light; the
  actions sit in a 36 px `control` capsule. Chrome icons are full ink.
- Composer: `control`, at least 48 high, radius 24, the column's width,
  floating 20 above the window's bottom edge. iPhone: a 48 pill beside a
  separate 48 × 48 attach button, 34 above the bottom. The mic stays in it.
- Side panel (the bot page, bot creation, group settings): floats like the
  sidebar, inset 8, radius 18, on the opaque `sheet`; the thread runs under
  it and no line separates them. Settings stay in groups with a segmented
  control. Activity groups by day on web, as on iPhone.
- Overlays (settings, Customize): an opaque `sheet` window, radius 24, on the
  `overlay` veil with the thread blurred 20 px under it. Its navigation is an
  inset panel like the app's sidebar: 8 from the window's edges, radius 16, on
  `rgba(255, 255, 255, 0.75)` in light and white 5% in dark. Sections are
  groups, as in the side panel.
- Menus, the account menu included, are `menu` at radius 14 with rows of 8;
  the palette is `list` at radius 20 with rows of 12.
- A run failure sits above the composer on a 44 px `destructive` tint at 8%,
  `rounded-full`, never as a block in the thread.
- Phone width on web and iPhone screens outside the thread take the same
  chrome: round buttons and capsules on `control`, lists and groups on the
  ambient light. The web drawer is the sidebar itself, on `list`, full height
  against the start edge with no radius, over a veil that blurs the thread
  6 px in the page background at 55% instead of darkening it: Safari's bars
  stay in that colour.
- Desktop window: the system's opaque window; the glass blurs the app's own
  ambient light, never the desktop. A window the app draws takes radius 26.
