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
- Messages are bubbles, not cards. Bot prose sits in a `muted` bubble, the
  person's words in the dark `chatUser` one; the thread elevates exactly one
  thing: a decision only a person can make.
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
| `chatUser` | `#111114` | `#3E3E44` | user bubble: ink in light, tone on tone in dark |
| `chatUserForeground` | `#FBFBF9` | `#F2F2F0` | |
| `mentionChip` | `#F1F1EE` | `#222226` | mention chip in the composer |
| `mentionChipForeground` | `#111114` | `#F2F2F0` | |
| `muted` | `#EDEDEB` [6%] | `#1F1F21` [8%] | bot bubble, segmented track |
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
`text-mono`, `text-composer`. Each carries its own line height, tracking and weight.

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
| `composer` | 17 | 1.294 | -0.01em | 400 | the mobile composer field (the native iOS body) |

Fonts: `--font-sans` is Geist Variable, `--font-mono` is Geist Mono Variable,
both bundled offline. `font-mono` pairs with `tabular-nums` wherever a number
ticks.

### Space

Layout, in px: `sidebar 280`, `thread 800`, `header 56`, `panel 384`, `block
520` — `w-sidebar`, `max-w-thread`, `h-header`, `w-panel`, `max-w-block` (a
framed block standing alone in the thread, §3.3); `composerField 220` —
`max-h-composer-field`, the web/desktop composer field before it scrolls
internally. Gaps use the native Tailwind scale, which accepts any
multiple of 0.25 rem: `gap-3.5` is 14, `gap-5.5` is 22, `gap-7` is 28. Never
`gap-[…]`.

### Radii

| Key | px | Utility | Use |
| --- | --- | --- | --- |
| `chip` | 6 | `rounded-chip` | section tags, draft highlights |
| `row` | 11 | `rounded-row` | sidebar rows and buttons |
| `card` | 14 | `rounded-card` | unframed cards, the panel |
| `draft` | 16 | — | shared draft (wave 2) |
| `block` | 18 | `rounded-block` | framed blocks |
| `bubble` | 18 | `rounded-bubble` | every message bubble, bot and user |
| `pill` | 9999 | `rounded-full` | capsules, round buttons, composer, avatars |

### Elevation

| Key | Light | Dark | Use |
| --- | --- | --- | --- |
| `row` | `0 1px 2px rgba(17, 17, 20, 0.06)` | `none` | selected sidebar row |
| `card` | `0 0 0 1px rgba(17, 17, 20, 0.08), 0 12px 30px -16px rgba(17, 17, 20, 0.4)` | `0 0 0 1px rgba(255, 255, 255, 0.08), 0 12px 30px -16px rgba(0, 0, 0, 0.8)` | framed blocks, the panel |
| `composerRest` | `0 0 0 1px rgba(17, 17, 20, 0.09)` | `0 0 0 1px rgba(255, 255, 255, 0.08)` | the composer at rest: a hairline only |
| `composerFocus` | `0 0 0 1px rgba(17, 17, 20, 0.09), 0 12px 28px -18px rgba(17, 17, 20, 0.55)` | `0 0 0 1px rgba(255, 255, 255, 0.16), 0 12px 28px -18px rgba(0, 0, 0, 0.8)` | the composer while its field has focus (dark also brightens the hairline) |
| `floating` | `0 1px 2px rgba(17, 17, 20, 0.08), 0 8px 20px -10px rgba(17, 17, 20, 0.35)` | `0 0 0 1px rgba(255, 255, 255, 0.08), 0 8px 20px -10px rgba(0, 0, 0, 0.7)` | the hover pill |
| `settled` | `0 0 0 1px rgba(17, 17, 20, 0.08)` | `0 0 0 1px rgba(255, 255, 255, 0.08)` | an answered framed block: the hairline without the drop |

Utilities `shadow-row`, `shadow-card`, `shadow-composer-rest`, `shadow-composer-focus`,
`shadow-floating`, `shadow-settled`.
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
| `pivot` | 320 ms, rotate -90° → 0 with scale and fade | the send arrow arriving with the first character |
| `morph` | 260 ms, rotate 45° | the mobile + turning into × while its sheet is open |
| `flow` | 2.6 s per lap | the Stop contour while a reply streams (static under reduced motion) |

### Sizes

Avatars: `receipt 14`, `stackXs 16`, `interstitial 17`, `chip 18`, `stack 20`,
`message 26`, `row 28`, `call 120`. Controls: `hoverIcon 28`, `quickReply 32`,
`composerIcon 34`, `capsule 36`, `mobileStack 44`, `callButton 52`. Mobile composer:
`composerAttach 48` (the detached + bubble), `composerTarget 44` (a button's
touch target in the capsule), `composerAction 36` (the send / stop disc).
Composer attachments (both devices): `composerAttachmentThumb 64` (the image
thumbnail / file-tile height), `composerAttachmentTile 200` (max width of a
file tile before its name truncates), `composerRemove 22` (the × disc).

The sizes a primitive needs as a class are mapped into Tailwind's spacing
namespace in `packages/ui-web/src/styles.css` — `--spacing-hover-icon`,
`--spacing-quick-reply`, `--spacing-composer-icon`, `--spacing-capsule`,
`--spacing-mobile-stack`, `--spacing-call-button`, `--spacing-message`,
`--spacing-composer-attachment-thumb`, `--spacing-composer-attachment-tile`,
`--spacing-composer-remove` — so `size-composer-icon`, `h-capsule` and
`w-message` resolve to the token instead of an arbitrary value. The rest are
spent through a `size` prop.

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
`actions?`, `answered?`. Anatomy: `bg-surface rounded-block shadow-card`, every
line inset by 14 (`px-3.5`) so its text starts where a bubble's text does; an
optional header line with a 6 px ink dot and `text-block-header`; the question
in `text-question`; the consequence in `text-meta`; `children` for controls; the
actions wrapped in a row of capsules. States: open (controls and actions) and
**answered** — setting `answered` settles the block: the controls and the
actions are dropped whether or not they are still passed, one `text-meta` line
takes their place, the root carries `data-answered="true"` and its shadow drops
to `shadow-settled`, giving the thread back its one elevation. Nothing that
cannot be pressed is left looking pressable.

The card is the body of a normal bot message row, full width of the column
rather than capped like a bubble — the group's name and avatar already say who
is asking, so the card repeats that only for a
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

`variant="outlined"` (mobile and web) trades the hairline for a 1 pt
`outline` edge: the thread's only outlined card, for a work product.

Do: tables, code blocks, agent cards. Don't: add `shadow-card` to make it stand
out — that shadow belongs to `FramedBlock`.

Used by: markdown tables, code blocks, cloud-agent and secret-ask cards;
outlined for a delegated task's result (subagent, cloud agent).

### Task card

A delegated task's result on `Surface variant="outlined"`, full column width: a
`doc.text` glyph in ink, the title (announced as a header), the brief in `meta`
on two lines, a `border` hairline, then the result. The whole card is one
target and opens the brief and result whole in a sheet; a long result fades
out under the expand badge. A finished task shows no status word; running,
failed and cancelled show the routine run's symbol and word under the title.

Web and desktop share this exactly: `apps/web/src/components/TaskCard.tsx`
exports `TaskCardSurface` (the visual card alone, `lucide-react`'s `FileText`
glyph) and `TaskCard` (the whole card as a button that opens a `ui-web`
`Dialog` with the brief and result). `CloudAgentCard` uses `TaskCardSurface`
directly, wrapped in its own link instead — it always opens its pull request
or URL in a new tab rather than a dialog, but keeps the same container, glyph
and status rule (nothing once `finished`).

### Routine run line

A routine run is a log line, not a card: no box, a 44 pt row with a status
symbol (`checkmark.circle.fill` success, `xmark.circle.fill` destructive,
`circle.dotted`, `clock`, `stop.circle` muted), the name (`rowName` 500, never
truncated), the time (`time`, tabular), the status word (`label` 500, muted, or
destructive when it failed), then fixed receipt, bell and disclosure slots kept
when empty so the columns line up. The disclosure is iOS's: `chevron.forward`
turning down. Opening shows the report under a 1 pt `outline` rail and, centred
like every exchange between bots, the message the run then sent (the collapsed
line carries it as the receipt bot's 14 pt avatar). A failed or subscribed run
opens on its report. Between two routine lines a time marker only says the day,
when it changes.

Earlier runs of the same routine with nothing between them fold into one line
(the routine's name, how many runs, the span, a cancelled count when there is
one); the latest run always keeps its own line. A failed or running run is
never folded, and — like a message from outside the routine — cuts the
sequence: nothing folds across it, so it never moves out of place. Only a
routine's latest run opens on its own (failed, or subscribed). An open group
lists each run; past eight runs it opens in a sheet, by day.

`packages/core/src/routine-groups.ts` is the one `foldRoutineRuns` both mobile
and web read groups from. Web renders it as `RoutineRunLine` /
`RoutineGroupLine` in `apps/web/src/pages/shell/routine-run-line.tsx`: the same
row, the same fold, the `ReasoningDisclosure` idiom (`lucide-react`'s
`ChevronRight` turning 90°) for the disclosure, a `border-s border-outline`
rail, the existing `CollaborationMarker` centred for the handoff, and a
`ui-web` `Dialog` (sectioned by day) once a group passes eight runs.

### Clipped preview

Content cut to a height (a routine report at eight lines, a task result at
five) fades into its host over 56 pt, with a 28 pt round expand badge
(`arrow.up.left.and.arrow.down.right`, `secondary` fill, `outline` ring) on the
fade, bottom right. The badge only marks it: the whole preview is the target
and opens the rest in a sheet. Content that fits is never cut.

`packages/ui-web/src/clipped-preview.tsx` is the web primitive: `ClippedPreview`
estimates from the raw text whether it is worth cutting, fades to a caller-given
`fadeFrom` token and opens a `Dialog` on click. Its `onOpen` is optional — when
an ancestor already opens the whole card (a `TaskCard`), it stays decoration
only, since a native `<button>` cannot nest another one.

### MessageRow

The scaffold around a bot message: who is speaking, never a fill of its own.

Props: `avatar`, `author`, `children`, `trailing?`, `showAuthor?`,
`showAvatar?`, `hasAvatarColumn?`. Messages are grouped by `computeMessageGroups`
(`packages/core/src/message-grouping.ts`, see Grouping). In a group thread the
author (`text-author`, inset 12 so it lines up with the bubble text) heads the
first message of a group and the avatar (`w-message`, bottom-aligned) sits at
the foot of the last one; the other rows keep the avatar column empty so every
bubble shares one edge, 8 from the avatar. A single-bot thread passes
`hasAvatarColumn={false}`: no name, no avatar, no gutter — the header already
says who this is. No row carries a permanent time; web reveals it on hover or
focus. The root is `group relative`, which reveals a `HoverPill` passed as
`trailing`.

The native mirror (`apps/mobile/components/message-row.tsx`) has the same
props with a `mono` flag.

Used by: every bot message in the thread, cards included.

### MessageBubble

What a bot said: `bg-muted rounded-bubble`, 10 × 14 padding, fitting its
content up to 82% of the thread (single bot) or 88% of the column (`inGroup`).
`meta?: { label, onClick? }` draws the proof line inside the bubble, under the
text, in `text-meta` suffixed by a chevron. Its `data-slot="message-row-bubble"`
scopes the markdown rules for a bubble: code on `background`, tables without a
surface, their hairlines running edge to edge.

One message is one bubble: never split a message by paragraph. Agent steps sit
above the bubble, unfilled.

The native mirror is `apps/mobile/components/bot-bubble.tsx`. It caps its width
with a number computed from the window: a bubble that fits its content has no
definite width, so a percentage (its own, or the markdown's `100%`) measures the
text wider than it draws and clips the last line.

Used by: bot narration (text and progress).

### UserBubble

What the person said: `bg-chat-user` (ink in light, tone on tone in dark),
`text-chat-user-foreground`, `rounded-bubble`, 10 × 15 padding,
`whitespace-pre-wrap`, at most 78% of the column, aligned to the end edge. The
dark fill is the person's alone: a bot never gets it, not even in a
conversation between bots.

Used by: user messages.

### Grouping

Consecutive messages from one author form a group: 3 between their bubbles, 14
between groups, 0 between two consecutive asides. A group breaks on a new
author, a time marker, more than five minutes, a reply, an aside (handoff, bot
message markers) and any card, which is always a group of its own.
`computeMessageGroups` is the one source of truth for web and mobile; call it
once per list, on the chronological messages, and read its result by id.

### Interstitial

A handoff between two bots, centred between messages and quiet enough to skip.

Props: `avatars` (usually a `StackedAvatars` at 17), `children`, `onClick?`. It
is a `div` until `onClick` makes it a `button` that fades on hover.

A marker cuts the bubble group around it; consecutive markers stack with no
gap. A handoff reads as a centred line between two 28 × 1 hairlines.

Used by: `bot_message_sent`, `bot_message_received` and `handoff` events.

### StackedAvatars

The bots behind a group, a delegation or a receipt, in one glance.

Props: `items: { color, identity?, working?, shapeSeed? }[]`, `size: 14 | 16 |
17 | 20` (native adds 28 for a header, with a round `+n` pill), `max?` (default 3), `label?`. Composes `BotAvatar`; each avatar after
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

Used by: the bottom of the web thread during a run. Mobile shows a typing
bubble instead (`apps/mobile/components/typing-bubble.tsx`): three pulsing dots
in a `muted` bubble, or the live activity line in `Shimmer` when one bot is
working and its activity is known.

### HoverPill

Message actions, absent until the row is hovered or focused from the
keyboard: `bg-surface`, `rounded-full`, `shadow-floating`, `opacity-0
pointer-events-none` at rest — `group-hover` and a `:focus-visible` inside the
row reveal it over `--duration-hover` (a click that leaves focus on a button,
such as unfolding a routine, does not pin it). It is for a bot's message only:
your own message gets bare Edit and resend / Copy icons under its bubble on
hover instead (`UserMessageActions`), and a routine line, which opens on a
tap, gets none. It sits next to the bubble it acts on, on the side facing the
thread's centre, when the bubble leaves room; otherwise at the row's top
`end` corner. The row measures this on enter and focus
(`hover-pill-placement.ts`) and hands it over as `data-pill="beside"` with
`--pill-x` / `--pill-y`. A bubble's time rides in the pill, ahead of the
actions. A touch pointer never hovers, so the
pill never appears there at all: touch reaches a message's actions through
`ActionSheet` instead (long press on the bubble, see below), not through a
coarse-pointer variant of this primitive.

Props: `children` — the message's time (`text-time`, muted) then
`roundIconSm` (`size-hover-icon`, 28 px) buttons, each with its own
`aria-label`: Reply, React, Copy, Speak/Stop (`message-hover-actions.tsx`).

Do: put it in `MessageRow`'s `trailing` slot. Don't: reveal it on click, or
anchor it to `right`.

Used by: Reply, React, Copy, Speak, Edit and resend, and More on a message.

### ActionSheet

A bottom-anchored action sheet, touch's own way into a message's actions —
opened by a 450 ms long press on a bubble (`transcript.tsx`), never by a tap.
Built on the same Base UI `Dialog` as the centered `Dialog` primitive, so
Escape, a backdrop click, and focus trapping come for free; this primitive
adds the bottom anchoring, the slide-up entrance and the drag-to-dismiss
gesture. Anatomy: full width, `max-w-thread` on larger screens, `rounded-t-block`,
a grab handle, a screen-reader-only `Dialog.Title` (the sheet shows no visible
heading). Dragging the handle down past 80 px (or a fast flick short of it)
closes it; short of that it snaps back. Entrance slides up over
`--duration-arrive`; under reduced motion it only fades in, never slides.

Props: `open`, `onOpenChange`, `title` (screen-reader only), `children`.

While held, the bubble itself settles to `scale(0.96)` after 150 ms
(`data-long-pressing="true"` on the row, a CSS rule scoped to
`[data-slot="message-row-bubble"]`/`[data-slot="user-bubble"]`, no transform
under reduced motion), and `-webkit-touch-callout: none` on both bubble slots
keeps iOS's own long-press callout from competing with the sheet opening
under it.

Used by: `message-actions-sheet.tsx` — the same quick reactions and action
handlers as `HoverPill`'s, reused rather than duplicated
(`message-actions.ts`), so touch and pointer never drift on what a message
allows.

### ComposerShell

The capsule at the bottom of the thread, and the one elevation of that screen:
`bg-surface rounded-composer shadow-composer-rest`, lifting to
`shadow-composer-focus` on `:focus-within` — a single elevation, not a
separate focus ring layered on top. Bottom-aligned (`items-end`) so its buttons stay on the last line
while the field grows; at least `min-h-12` (48 px) even empty.

Props: `attach?` (the attach button — the capsule's **leading edge**, before
any chip: `+ · [chips] · text · [mic] · action(s)`), `leading?` (a
mention/skill chip, or the speaking bot's avatar), `children` (the field),
`trailing?` (round-icon buttons: dictate, then send / stop), `attachments?` (a
row of `ComposerAttachment`, rendered **above** the input line, inside the
capsule — pending attachments and rewind artifacts both land here, wrapping on
web), `state?: idle | typing | dictating | speaking`.

**Dictation mode** (`state="dictating"`): the capsule swaps its ambient
`shadow-composer-rest`/`-focus` for a 1.5 px `foreground` ring (`+` and any
chip stay in place, just inactive — the caller disables them). Two new props
draw a row **under** the field: `dictationCancel?` (×, start) and
`dictationConfirm?` (✓ — plus Stop when a reply is running — end), with this
component's own four bars in between as the waveform (`data-slot="composer-
dictating"`, `aria-hidden`, 3 × 14, reused unchanged from before dictation
existed). Only drawn together with the row when `state="dictating"`. The
field itself is the caller's job: `apps/web/src/pages/shell/composer.tsx`
swaps its `<textarea>` for a read-only preview `<div>` while dictating (a
textarea can't style a range), showing the pre-dictation draft plus each
dictated word fading/blurring in over 260 ms (`rk-word-in`, off under reduced
motion) and the not-yet-final tail in `mutedForeground`. The `speaking` beat
is composed from the slots, so its label stays translatable.

**Removed**: the `working` state and its three dots — a run in
progress is now carried by the Stop button's own contour (`StopContour`), not
by chrome inside the capsule.

Do: show Send only when the draft or a chip is non-empty; put the attach
button in `attach`, never in `trailing`; dictation and the call never fight
over the composer — the call moved to the thread header (a phone icon labelled `Voice`, 1:1
only; the mic always means dictation) and cancels a dictation in progress before it opens. Don't: put a second
shadow inside the capsule, reach for `state="working"` (removed), or let
dictation send anything itself — ✓ only inserts into the draft.

Used by: the thread composer (`apps/web/src/pages/shell/composer.tsx`); the
call button lives in `apps/web/src/pages/shell/thread-header.tsx` instead.

### ComposerAttachment

A pending attachment, or a rewind artifact, inside the composer's
`attachments` slot: an image thumbnail, or a file tile with a paperclip and a
truncated name, each carrying a × disc.

Props: `name` (alt text, or the file tile's truncated label), `previewUrl?`
(present → thumbnail; absent → file tile), `removeLabel` (the caller's
translated "Remove {name}"), `onRemove?`, `disabled?` (× inert while
dictating — the attachment itself stays visible and unchanged). Anatomy: `size-composer-attachment-thumb`
(64 px) `rounded-card` thumbnail, or a `bg-secondary` `rounded-card` tile
capped at `max-w-composer-attachment-tile` (200 px) with a truncated name; the
× is a `size-composer-remove` (22 px) `bg-primary` disc with a `border-surface`
ring, absolutely positioned at the top end corner.

Do: use it for both `pendingAttachments` and `rewindArtifacts` — never a plain
pill above the composer. Don't: let a long file name widen the tile; it
truncates instead.

Used by: the thread composer's `attachments` slot.

### StopContour

The Stop button's own edge: the contour **is** the rim
of the disc, not a ring drawn outside it — two glows of the responding bot's
colour chase each other around a 2 px ring, one lap per `--duration-flow`
(2.6 s), while the disc (`bg-primary`) sits at `inset-0.5` and a small
`bg-primary-foreground` square marks the button underneath. No head, no
accessible name — it fills a `roundIcon` button that already has one.

Props: `color?` — the bot's identity colour as a plain CSS colour string, the
same precedent as `BotAvatar`'s `color` prop (data, not a token; carried as
the inline custom property `--contour`). Omit it in a group, or when no bot is
known: the contour falls back to `color-mix(in srgb, var(--foreground) 45%,
transparent)`. Reduced motion: the ring holds still, fully lit, no rotation.

Do: pass the room's single bot's colour when there is one. Don't: give it an
`aria-label` — the wrapping button owns "Stop".

Used by: the thread composer's Stop button, while a run is going.

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
