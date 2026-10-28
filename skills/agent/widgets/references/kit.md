# Widget kit

Read this when a case template does not fit. Rakazo preloads this kit and the
current theme's tokens. Do not recreate them or invent additional kit classes.
Use semantic elements and the classes below. Inline styles may use the allowed
tokens for a property the kit does not cover, or SVG sizing such as `width:100%`.

## Element defaults

- Rakazo supplies a transparent body with 16px padding, reduced to 12px below 480px.
- Headings, paragraphs, lists, links, `small`, and `hr` have default typography and spacing.
- Images and videos are fluid and rounded. Audio has native playback controls.
- Tables, column headings, and cells have default borders and spacing.
- Buttons have default styling. Use `.button` for a 44px tap target.
- `[hidden]` hides any element, including a `.grid` or `.stack` panel.
- Inherit the app font. Do not set a font family or load fonts.

## Classes

| Class | Contract and use |
| --- | --- |
| `.stack` | Column layout with 12px gaps. Use for the root and vertical card content. |
| `.row` | Horizontal layout, wraps, centers items, 12px gaps. Use for controls and badges. |
| `.grid` | Auto-fit columns of at least 200px; one column below 480px. Use for cards and galleries. |
| `.card` | Inner content box: card background, border, 16px padding, `--radius` corners. Never wrap the whole widget in it. |
| `.muted` | Secondary text. Keep important values in the normal foreground. |
| `.badge` | Small outlined label. Use for a fact or status, never as an action. |
| `.button` | 44px action with rounded corners on a real `<button>` or `<a>`. Give it visible text or an accessible name. |
| `.button.secondary` | Outlined secondary action. Write `class="button secondary"`, never `class="secondary"` alone. |
| `.tabs` | Segmented control containing buttons with tab semantics. Selected tabs are highlighted. |
| `.stat` | KPI container. Put the value and its label inside it. Combine with `.card` when grouping KPIs. |
| `.value` | Value inside `.stat`. Include its unit when it is not clear from the label. |
| `.label` | Label inside `.stat`. Name the measure and period where needed. |
| `.media` | On `<figure>`. Its image/video uses a 16:9 cover crop, with a `figcaption` below. |

Use `.grid` instead of writing a fixed column count. Use `.row` instead of forcing
controls onto one line. Use `.stack` instead of adding margins between every child.
Keep an essential diagram or image uncropped by using a plain figure, not `.media`.
Never add an outer background, card, border, or title banner. The app supplies them.
Never set a background on html/body or the outermost element. Use `.card` for inner boxes.

## Tabs and buttons

Set `role="tablist"` and an accessible name on `.tabs`. Each child is
`<button type="button" role="tab" aria-selected="true|false" aria-controls="panel-id">`.
Give each tab an ID. Its panel uses `role="tabpanel"`, `aria-labelledby="tab-id"`,
and `tabindex="0"`. Set only the selected tab's `tabindex` to `0`; use `-1` on others.
The kit styles selection; it does not switch panels. Copy the short script in
`explain.md` or `travel.md`. It updates selection, tab stops, and panel visibility,
and supports arrow keys, Home, and End. Keep exactly one panel visible per group.
Keep controls at least 44px wide as well as tall. Never use clickable divs.
Use a button for a local action and an HTTPS anchor for an external destination.

## Allowed color tokens

Use `var(--token-name)`. This list is exhaustive for widget-authored styles.
Do not copy raw values from the app's stylesheet into widget code.

| Tokens | Use |
| --- | --- |
| `--foreground` | Main text and monochrome marks. SVG may use `currentColor`. |
| `--muted-foreground` | Secondary text and annotations. |
| `--card`, `--card-foreground` | Card background and its readable foreground. |
| `--muted` | Quiet background area. |
| `--border` | Dividers and outlines. |
| `--primary`, `--primary-foreground` | Primary action background and text. |
| `--secondary`, `--secondary-foreground` | Secondary action background and text. |
| `--destructive` | Failure or destructive status, with a text label. |
| `--success` | Success status, with a text label. |
| `--warning` | Warning status, with a text label. |
| `--ring` | Visible keyboard focus outline. Never remove focus indication. |
| `--background` | Page background; only for a selected tab or an inset that must contrast with `--muted`. |

Photos may carry color. UI and charts stay monochrome. Never use status colors
to distinguish series or options. No hex, rgb, named palette colors, gradients,
or shadows. `none` and `currentColor` are valid SVG paint values.

## Allowed shape, type, and motion tokens

Type is set by the kit: body 15px, `h1` 22px, `h2` 17px, `h3` 15px, tables 14px,
`small`, captions and `.label` 13px, `.badge` 12px, `.stat .value` 28px. Reuse
these sizes; never invent a new one. The font is the system font the app uses.

| Tokens | Use |
| --- | --- |
| `--radius` | Card corner. Smaller elements use `calc(var(--radius) - 4px)` (buttons, images) or `calc(var(--radius) - 6px)` (badges, tabs). Prefer a kit class. |
| `--duration-hover`, `--duration-press` | Optional control transition durations. Never require hover. |
| `--motion-ease` | Timing function with a duration token. |

Use only 4/8/12/16/24px spacing. Do not invent a spacing, size, corner, shadow,
or motion token. Data coordinates, percentages, and SVG `viewBox` dimensions
describe the graphic, not UI spacing. Never use vh/dvh/svh/lvh or `height:100%` on
html/body or the outermost element. Content sizes the frame; those heights cause
endless growth. Prefer no animation; respect reduced motion when it is necessary.

## SVG chart rules

1. Write inline `<svg>` with a `viewBox`, an intrinsic `width` matching its width,
   a fixed pixel height such as `height="244"`, and `style="max-width:100%"`.
   It fits phones without growing forever. Never use viewport or percentage heights.
2. Use a compact viewBox around 320 units wide so labels remain readable at 360px.
   Give labels `font-size:13px` and inherit the font.
3. Add `role="img"`, `<title id="…">`, and `aria-labelledby`. Add `<desc>` and
   `aria-describedby` or include its ID in `aria-labelledby` for a detailed chart.
4. Use `fill="currentColor"`, `stroke="currentColor"`, and opacity for series.
   Use at most two series. Put their names and opacity meanings in visible text.
5. Label categories, units, and values directly. Do not require a tooltip or hover.
   Keep data available in nearby text or a compact table for precise reading.
6. Begin bars at zero. Use a shared scale and leave space for value labels.
   If values are negative, show a labeled zero baseline and extend bars either side.
7. Keep labels out of bars, avoid tiny tick labels, and omit decorative grid lines.
   Never clip labels to make a chart fit. Reduce categories or show another panel.
8. Use real buttons outside the SVG for filters. Do not make tiny marks tap targets.
   Keep the main finding visible above the chart; put long detail behind tabs or steps.

Widgets may reload at any time due to scrolling, theme changes, or full screen.
Do not rely on local state surviving or build input-heavy forms.

## Keep kit and skill together

When the kit changes, update this class/token inventory in the same change.
When a widget renders poorly, fix its case template or pitfalls first.
Render each changed template once at 390px and desktop width before landing it;
keep those screenshots with the review. A permanent test suite per template is unnecessary.
