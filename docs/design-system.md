# Design system — Quiet

The living reference for the Quiet skin: seven token families in
`@rakazo/ui-tokens` and the named primitives in `@rakazo/ui-web` that spend
them. The design contract that produced it is
`docs/plans/2026-09-16-quiet-redesign.md`; this file is what stays true
afterwards.

**A screen never defines a colour, a size, a radius, a shadow or a duration by
hand. It composes tokens and primitives from `@rakazo/ui-web`.** A hex, a
`text-[…]`, a `rounded-[…]`, a `shadow-[…]`, a `w-[…]` or a `duration-[…]` in a
screen is a bug: the value belongs in `packages/ui-tokens/src/index.ts`, and the
arrangement belongs in a primitive.

## Principles

- Two panes, no chrome in between: the sidebar and the thread, nothing framing
  them.
- Messages are not cards. The thread frames exactly one thing: a decision only a
  person can make.
- Ink everywhere. A bot's colour lives in its avatar and nowhere else.
- One elevation per screen. Everything else is a fill and a hairline.
- Nothing loops except the avatar of a bot that is working.
- Every visible word is UI: if it can be removed, remove it.

## Tokens

One TypeScript source, `packages/ui-tokens/src/index.ts`, generates
`tokens.css`; `packages/ui-web/src/styles.css` maps it into Tailwind's
`@theme inline`; mobile reads the same objects through
`apps/mobile/lib/appearance`. Run
`pnpm --filter @rakazo/ui-tokens generate` after any change to the source.

### Colour

Every slot is opaque. The design expresses its greys as veils of ink or white;
they are flattened on `background` (the veil is noted in brackets) because
opacity modifiers, `color-mix` and native stacked fills all treat these as full
colours. An `rgba` in a slot is a bug.

| Slot | Light | Dark | Role |
| --- | --- | --- | --- |
| `background` | `#FBFBF9` | `#0C0C0E` | the page |
| `foreground` | `#111114` | `#F2F2F0` | ink: text, primary |
| `foregroundSubtle` | `#86868B` | `#6E6E73` | passive grey: sidebar second line, placeholders (≈ 3.3:1) |
| `card`, `popover` | `#FFFFFF` | `#161618` | cards, popovers |
| `cardForeground`, `popoverForeground` | `#111114` | `#F2F2F0` | |
| `primary` | `#111114` | `#F2F2F0` | primary capsule, Send |
| `primaryForeground` | `#FBFBF9` | `#0C0C0E` | |
| `secondary` | `#EDEDEB` [ink 6%] | `#1F1F21` [white 8%] | secondary capsule, Stop |
| `secondaryForeground` | `#111114` | `#F2F2F0` | |
| `chatUser` | `#F1F1EE` | `#222226` | user bubble, mention chip |
| `chatUserForeground` | `#111114` | `#F2F2F0` | |
| `muted` | `#EDEDEB` [6%] | `#1F1F21` [8%] | segmented track |
| `mutedForeground` | `#6E6E73` | `#9A9AA1` | clickable grey: meta, times, section labels, icons |
| `accent` | `#EFEFEE` [5%] | `#1B1B1C` [6%] | icon-button hover |
| `accentForeground` | `#111114` | `#F2F2F0` | |
| `border`, `sidebarBorder` | `#E8E8E7` [8%] | `#1F1F21` [8%] | hairline of cards and blocks |
| `outline` | `#DADAD9` [14%] | `#333335` [16%] | quick-reply edge, stronger than `border` |
| `input` | `#DFDFDE` [12%] | `#29292B` [12%] | field edge |
| `ring` | `#6E6E73` | `#9A9AA1` | focus |
| `surface` | `#FFFFFF` | `#161618` | the one elevation: composer, framed blocks, cards, hover pill |
| `sidebar` | `#F4F4F3` [2.8%] | `#131315` [3%] | left pane |
| `sidebarForeground` | `#111114` | `#F2F2F0` | |
| `sidebarAccent` | `#FFFFFF` | `#1D1D1F` [7%] | selected and hovered row |
| `sidebarAccentForeground` | `#111114` | `#F2F2F0` | |
| `link` | `#2563EB` | `#86B7FF` | |
| `destructive` | `#DC2626` | `#EF4444` | |
| `destructiveForeground` | `#FFFFFF` | `#FFFFFF` | |
| `success` | `#228B3B` | `#4ECB71` | |
| `warning` | `#B7791F` | `#E9C46A` | |
| `overlay` | `rgba(20, 20, 22, 0.45)` | `rgba(4, 4, 5, 0.62)` | |
| `scrollbar` | `#C8C8C4` | `#2A2A2E` | |
| `scrollbarHover` | `#A8A8A4` | `#414147` | |

`botColors` is user data and never changes with the skin.

### Typography

Utilities: `text-body`, `text-author`, `text-time`, `text-meta`, `text-label`,
`text-row-name`, `text-row-status`, `text-title`, `text-capsule`,
`text-working`, `text-reasoning`, `text-block-header`, `text-question`,
`text-mono`. Each carries its own line height, tracking and weight.

| Key | Size | Leading | Tracking | Weight | Use |
| --- | --- | --- | --- | --- | --- |
| `body` | 16.5 | 1.58 | -0.008em | 400 | message prose (mobile 16 / 1.5) |
| `author` | 13 | 1.3 | -0.004em | 500 | bot name above a message |
| `time` | 12 | 1.3 | 0 | 400 | time beside the name |
| `meta` | 13 | 1.4 | 0 | 400 | proof line under a message |
| `label` | 12.5 | 1.3 | 0 | 400 | sidebar section labels, day markers |
| `rowName` | 14.5 | 1.3 | -0.005em | 400 | sidebar row name (500 selected, mobile inbox 18 / 500, 600 unread) |
| `rowStatus` | 12.5 | 1.3 | 0 | 400 | sidebar status line (mobile inbox 15) |
| `title` | 19 | 1.2 | -0.014em | 500 | thread title (mobile 17 / 600) |
| `capsule` | 14 | 1 | 0 | 400 | capsule labels (500 primary) |
| `working` | 15 | 1.3 | -0.006em | 400 | "… is drafting the recap" |
| `reasoning` | 13.5 | 1.45 | 0 | 400 | reasoning summary and steps |
| `blockHeader` | 12.5 | 1.3 | 0.01em | 500 | framed-block header |
| `question` | 16 | 1.45 | -0.008em | 400 | framed-block question |
| `mono` | 12.5 | 1.3 | 0 | 400 | durations and figures |

Fonts: `--font-sans` is Geist Variable, `--font-mono` is Geist Mono Variable,
both bundled offline. `font-mono` pairs with `tabular-nums` wherever a number
ticks.

### Space

Layout, in px: `sidebar 280`, `thread 800`, `header 56`, `panel 384`, `block
520` — `w-sidebar`, `max-w-thread`, `h-header`, `w-panel`, `max-w-block` (a
framed block standing alone in the thread, §3.3). Gaps use the native Tailwind
scale, which accepts any multiple of 0.25 rem: `gap-3.5` is 14, `gap-5.5` is 22,
`gap-7` is 28. Never `gap-[…]`.

### Radii

| Key | px | Utility | Use |
| --- | --- | --- | --- |
| `chip` | 6 | `rounded-chip` | section tags, draft highlights |
| `row` | 11 | `rounded-row` | sidebar rows and buttons |
| `card` | 14 | `rounded-card` | unframed cards, the panel |
| `draft` | 16 | — | shared draft (wave 2) |
| `block` | 18 | `rounded-block` | framed blocks |
| `bubble` | 19 | `rounded-bubble` | user bubble |
| `pill` | 9999 | `rounded-full` | capsules, round buttons, composer, avatars |

### Elevation

| Key | Light | Dark | Use |
| --- | --- | --- | --- |
| `row` | `0 1px 2px rgba(17, 17, 20, 0.06)` | `none` | selected sidebar row |
| `card` | `0 0 0 1px rgba(17, 17, 20, 0.08), 0 12px 30px -16px rgba(17, 17, 20, 0.4)` | `0 0 0 1px rgba(255, 255, 255, 0.08), 0 12px 30px -16px rgba(0, 0, 0, 0.8)` | framed blocks, the panel |
| `composer` | `0 1px 2px rgba(17, 17, 20, 0.06), 0 12px 28px -18px rgba(17, 17, 20, 0.5)` | `0 0 0 1px rgba(255, 255, 255, 0.08), 0 12px 28px -18px rgba(0, 0, 0, 0.8)` | the composer capsule |
| `floating` | `0 1px 2px rgba(17, 17, 20, 0.08), 0 8px 20px -10px rgba(17, 17, 20, 0.35)` | `0 0 0 1px rgba(255, 255, 255, 0.08), 0 8px 20px -10px rgba(0, 0, 0, 0.7)` | the hover pill |

Utilities `shadow-row`, `shadow-card`, `shadow-composer`, `shadow-floating`.
Unframed cards have **no** shadow: `bg-surface` and a `border` hairline.

### Motion

| Key | Value | Use |
| --- | --- | --- |
| `ease` | `cubic-bezier(0.32, 0.72, 0, 1)` | every transition (`ease-quiet`) |
| `arrive` | 240 ms, `translateY(6px)` → 0, 0 → 1 opacity | a message, block or capsule arriving (`animate-arrive`) |
| `press` | 160 ms, `scale(0.96)` capsules (`rk-press`), `scale(0.94)` round controls (`rk-press-round`) | pressing |
| `hover` | 160 ms | colour and fill on hover (`duration-(--duration-hover)`) |
| `breathe` | 5.6 s | the idle avatar |
| `caret` | 1 s step-end | the typing caret |

### Sizes

Avatars: `receipt 14`, `stackXs 16`, `interstitial 17`, `chip 18`, `stack 20`,
`message 26`, `row 28`, `call 120`. Controls: `hoverIcon 28`, `quickReply 32`,
`composerIcon 34`, `capsule 36`, `mobileStack 44`, `callButton 52`.

The seven sizes a primitive needs as a class are mapped into Tailwind's spacing
namespace in `packages/ui-web/src/styles.css` — `--spacing-hover-icon`,
`--spacing-quick-reply`, `--spacing-composer-icon`, `--spacing-capsule`,
`--spacing-mobile-stack`, `--spacing-call-button`, `--spacing-message` — so
`size-composer-icon`, `h-capsule` and `w-message` resolve to the token instead
of an arbitrary value. The rest are spent through a `size` prop.

## Primitives

Every primitive lives in `packages/ui-web/src/<name>.tsx`, is exported from the
barrel, carries `data-slot="<name>"` on its root, merges a `className` through
`cn`, holds no copy (labels arrive as props or children, icon buttons take
`aria-label`), and has a `renderToString` test next to it. Each one also spreads
the remaining native props of its root element, so a screen can attach a
`data-testid`, an `id` or an `aria-*` without a wrapper.

The plain classes the primitives apply — `rk-press`, `rk-press-round`, `rk-bar`,
`rk-dot`, `rk-shimmer` — live in Tailwind's `components` layer, so a utility
passed through `className` always wins over them.

### Button — Quiet variants

`packages/ui-web/src/components/ui/button.tsx`. The stock shadcn variants are
untouched; the Quiet ones are added beside them. **Pair each variant with its
matching size** — the variant carries the fill and the horizontal padding, the
size carries the height or the square.

| Variant | Anatomy |
| --- | --- |
| `capsule` | `bg-primary`, `text-primary-foreground`, `text-capsule` at 500, `rounded-full`, hover to 85% opacity |
| `capsuleSecondary` | `bg-secondary` on ink text, otherwise the capsule |
| `tertiary` | transparent, `text-muted-foreground`, ink on hover |
| `quickReply` | transparent inside a `border-outline` hairline, `bg-accent` on hover |
| `roundIcon` | transparent circle, `text-muted-foreground`, `bg-accent` on hover |

| Size | px | Utility |
| --- | --- | --- |
| `capsule` | 36 | `h-capsule` |
| `quickReply` | 32 | `h-quick-reply` |
| `roundIcon` | 34 | `size-composer-icon` |
| `roundIconSm` | 28 | `size-hover-icon` |
| `stack` | 44 | `h-mobile-stack` |
| `call` | 52 | `size-call-button` |

`consequential` prefixes a 13 px lock and sets `data-consequential="true"`, so
an action that cannot be taken back reads as one before it is pressed. The size
also decides the press: a capsule settles to 0.96, a round control to 0.94.
Every variant focuses on `ring`.

Do: `<Button variant="capsule" size="capsule">{t\`Allow once\`}</Button>`.
Don't: a Quiet variant with the default size, or a capsule whose label is
written inside the primitive.

Used by: the framed block's actions, quick replies, the composer, the hover
pill, the call view.

### FramedBlock

The only framed element of the thread: a decision or a question the bot cannot
settle alone.

Props: `header?: { who, dot? }`, `question`, `consequence?`, `children?`,
`actions?`, `answered?`. Anatomy: `bg-surface rounded-block shadow-card`; an
optional header line with a 6 px ink dot and `text-block-header`; the question
in `text-question`; the consequence in `text-meta`; `children` for controls; the
actions wrapped in a row of capsules. States: open (controls and actions) and
**answered** — setting `answered` settles the block: the controls and the
actions are dropped whether or not they are still passed, one `text-meta` line
takes their place and the root carries `data-answered="true"`. Nothing that
cannot be pressed is left looking pressable.

The card is the body of a normal bot message row — the row's own avatar and
name already say who is asking, so the card repeats that only for a
consequential approval, name-less ("Needs your call"); a plain question,
`ask_user` question, or `choice` passes no `header` at all and opens straight
on the question.

Do: one open block per thread. Don't: frame an ordinary message, or stack a
second shadow inside it.

Used by: approval asks and bot questions (`ask`, `ask_user`, `choice`), each
rendered as a normal bot row.

### Surface

The unframed card: one fill, one hairline, never a shadow.

Props: `radius?: "card" | "block"` (default `card`), `as?`. Renders
`bg-surface border border-border` with `rounded-card` or `rounded-block`.

Do: tables, code blocks, routine and agent cards. Don't: add `shadow-card` to
make it stand out — that shadow belongs to `FramedBlock`.

Used by: markdown tables, code blocks, routine-run, cloud-agent and secret-ask
cards.

### MessageRow

A bot message: avatar, name, time, prose. No fill, no border.

Props: `avatar`, `author`, `time?`, `children`, `meta?: { label, onClick? }`,
`trailing?`. The avatar column is `w-message` wide so every row starts on the
same line whatever the avatar renders. The header is `text-author` plus
`text-time`; the body is `text-body text-pretty`; `meta` is a button in
`text-meta` suffixed by a chevron. The root is `group relative`, which is what
reveals a `HoverPill` passed as `trailing`.

Do: put the proof line in `meta` so it stays one tap from the message. Don't:
give the row a background to "group" it.

The native mirror (`apps/mobile/components/message-row.tsx`) spends the `body`
token on a string child and drops a node child into a plain `View` instead:
React Native has no style inheritance through a `View`, so markdown and cards
bring their own typography.

Used by: every bot message in the thread.

### UserBubble

What the person said, the one filled bubble of the thread: `bg-chat-user`,
`rounded-bubble`, `whitespace-pre-wrap`, at most 78% of the column, aligned to
the end edge.

Used by: user messages.

### Interstitial

A handoff between two bots, centred between messages and quiet enough to skip.

Props: `avatars` (usually a `StackedAvatars` at 17), `children`, `onClick?`. It
is a `div` until `onClick` makes it a `button` that fades on hover.

Used by: `bot_message_sent`, `bot_message_received` and `handoff` events.

### StackedAvatars

The bots behind a group, a delegation or a receipt, in one glance.

Props: `items: { color, identity?, working?, shapeSeed? }[]`, `size: 14 | 16 |
17 | 20`, `max?` (default 3), `label?`. Composes `BotAvatar`; each avatar after
the first slides under the previous one by 5, 4 or 3 px depending on the size,
and the rest collapse into `+N` in `text-label`. With a `label` the stack is a
`role="img"` carrying that name; without one it is `aria-hidden`, which is right
whenever the sentence beside it already names the bots.

Do: keep `max` at 3 in a header. Don't: reach for it at 26 or above — that is a
single `BotAvatar`.

Used by: the thread header, interstitials, mobile headers.

### WorkingLine

The only thing that moves while a bot works: a working avatar, what it is doing
in `text-working`, and the elapsed time in `font-mono text-mono tabular-nums`.

Props: `avatar?`, `label`, `startedAt?`. The root is a `role="status"` region;
the duration is `aria-hidden` so a screen reader hears the sentence once
instead of every tenth of a second. The tick comes from `useElapsed`, exported
from the same package and shared with the loading states in
`apps/web/src/components/ai/`: under reduced motion it freezes at its first
reading, so nothing animates a number at someone who asked for stillness.
`avatar` is optional: omit it (as the reconnect and update-progress loading
states do — there is no bot) and the reserved avatar column disappears too,
instead of leaving a blank 26 px gap.

Used by: the bottom of the thread during a run.

### HoverPill

Message actions, absent until the row is hovered or focused: `bg-surface`,
`rounded-full`, `shadow-floating`, anchored to the `end` edge. On a fine
pointer (`pointer-fine:`), it is `opacity-0 pointer-events-none` at rest;
`group-hover` and `group-focus-within` on the row reveal it over
`--duration-hover`. A coarse pointer has no hover to reveal it with, so it
stays visible by default — the primitive itself only ever gates on
`pointer-fine:`; a coarse pointer is always the unconditional (visible) case.

Props: `children` — `roundIconSm` buttons, each with its own `aria-label`.
`roundIconSm` is `size-hover-icon` (28 px) on a fine pointer and
`pointer-coarse:size-11` (44 px) on a coarse one, composed by the caller —
the primitive does not size its children.

Two densities, both composed by the caller from the same children (see
`message-hover-actions.tsx`): on a **fine** pointer the pill holds Reply ·
React · Copy · Speak · More, each `hidden pointer-fine:grid` (except React,
always shown); on a **coarse** pointer it holds only React and More
(`hidden pointer-coarse:grid`) — Reply, Copy, Speak/Stop and Edit and resend
move into More's menu there instead (`pointer-fine:hidden` on those menu
items, so they don't also duplicate a fine pointer's dedicated icons). Edit
and resend is never a pill icon on either density, since it is not one of the
five; if a row has nothing else for More to hold on a fine pointer (a bot
row, say), More itself hides there rather than open onto an empty menu.

Do: put it in `MessageRow`'s `trailing` slot. Don't: reveal it on click,
anchor it to `right`, or repeat a pill icon inside More on the density where
that icon is already visible.

Used by: Reply, React, Copy, Speak, Edit and resend, and More on a message.

### ComposerShell

The capsule at the bottom of the thread, and the one elevation of that screen:
`bg-surface rounded-full shadow-composer`.

Props: `leading?` (a mention chip, or the speaking bot's avatar — it tightens
the leading padding), `children` (the field), `trailing?` (round-icon buttons),
`state?: idle | typing | dictating | speaking | working`. `dictating` draws four
3 × 14 bars, `working` draws three dots; both are `aria-hidden` chrome. The
`speaking` beat is composed from the slots, so its label stays translatable.

Do: show Send only when the draft or a chip is non-empty. Don't: put a second
shadow inside the capsule.

Used by: the thread composer.

### ReasoningDisclosure

What the bot thought, folded away until someone asks.

Props: `summary` ("Thought for 41s · 4 steps", translated by the caller),
`open`, `onToggle`, `children` (one node per step), `live?`, `toggleProps?`. The
toggle is a `button` with `aria-expanded` and, once open, an `aria-controls`
pointing at the panel; the open panel rails the steps behind a logical
`border-s` and shimmers the **last** step while `live`. `toggleProps` lands on
the toggle, which is where a screen puts its testid. A summary reads a finished
total through `formatShortDuration` (`41s`, `2m 04s`), not the running
`formatElapsed` clock of `WorkingLine`.

Do: keep the existing "Display agent steps" setting in charge of whether it
renders at all. Don't: animate the steps while they arrive — the shimmer is the
only live signal.

Used by: the `steps` block of a message.

### Shimmer

A light sweep across a label that is still being written, as the `rk-shimmer`
class. Ported from beautifului.dev
(github.com/TurboKach/ai-native-react-components, MIT © 2026 Turbo).

## Motion rules

- One easing curve, `ease-quiet`, for every transition.
- `animate-arrive` for a message, block or capsule entering; capsules in one row
  stagger 60 ms apart.
- `rk-press` on anything pressable; `duration-(--duration-hover)` for hover.
- **Nothing loops continuously except the avatar of a bot that is working**, and
  its idle breathing.
- `prefers-reduced-motion: reduce` stops `animate-arrive`, `rk-press`,
  `rk-press-round`, `rk-bar`, `rk-dot`, `rk-shimmer`, the avatar morph and body
  and the working eye loop, and freezes every `useElapsed` duration. **The idle
  eye blink keeps running** on both avatar variants — it is the one motion the
  contract preserves — and the working glow stays, static.

## Accessibility

- Text that carries information is `foreground` or `mutedForeground` (≥ 4.5:1).
  `foregroundSubtle` is for the sidebar's second line and placeholders only, and
  never alone when the information matters.
- Every icon button has a translated accessible name. Primitives expose
  `aria-label` through props and never hold copy of their own.
- Logical properties everywhere (`ps-`, `pe-`, `start-`, `end-`, `border-s-`):
  the product is RTL-ready. The hover pill and the side panel sit at `end`.
- Touch targets are ≥ 44 pt when stacked on mobile; 32 pt in flow is reserved
  for quick replies.
- Copy is English in the code, through lingui (`t` / `Trans`), then
  `pnpm --filter @rakazo/web intl:extract`.

## Kitchen sink

`apps/web/e2e/fixtures/design-system.html` renders every primitive in every
state against the real compiled CSS. `apps/web/e2e/design-system.spec.ts`
asserts a few semantic facts — including that a caller's utility beats a
primitive's own class — and captures it light and dark; the screenshots are
documentary, never a pixel diff. Both need the Vite dev server, because the
fixture is served from source and is not a build entry.
`apps/web/e2e/tsconfig.json` type-checks the fixtures, and `pnpm check` in the
web app runs it as a second pass.
