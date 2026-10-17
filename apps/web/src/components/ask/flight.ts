import type { CommitSource } from "@rakazo/core";
import { motion, springEasing } from "@rakazo/ui-tokens";
import { flushSync } from "react-dom";

type Rect = { left: number; top: number; width: number; height: number };

/** The filled tile or field an answer leaves from, taken from the card just before it settles. */
export type Departure = {
  /** Null when a button sent the answer: the bubble rises from the card's foot, nothing flies. */
  from: { rect: Rect; radius: string; inset: string } | null;
  height: number;
  ghost: Element;
  list: HTMLElement | null;
  /** Where each row of the list stood, to slide it from there to its new place. */
  rows: Map<Element, number>;
};

const SOURCE = { option: '[aria-pressed="true"]', field: '[data-slot="option-field"]' };

function within(element: Element, card: Element): Rect {
  const rect = element.getBoundingClientRect();
  const origin = card.getBoundingClientRect();
  return {
    left: rect.left - origin.left,
    top: rect.top - origin.top,
    width: rect.width,
    height: rect.height,
  };
}

const frame = ({ left, top, width, height }: Rect, borderRadius: string) => ({
  left: `${left}px`,
  top: `${top}px`,
  width: `${width}px`,
  height: `${height}px`,
  borderRadius,
});

function scrollingList(card: HTMLElement) {
  let node = card.parentElement;
  while (node && !/auto|scroll/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
  return node;
}

/** Measures the card and the list it sits in, before the card settles. */
export function departure(card: HTMLElement, leaving: CommitSource): Departure | null {
  const selector = leaving.kind === "button" ? null : SOURCE[leaving.kind];
  const source = selector ? card.querySelector(selector) : null;
  const content = card.lastElementChild;
  if ((selector && !source) || !content) return null;
  const ghost = content.cloneNode(true) as HTMLElement;
  if (selector)
    ghost.querySelector<HTMLElement>(selector)?.style.setProperty("visibility", "hidden");
  for (const element of ghost.querySelectorAll("[id]")) element.removeAttribute("id");
  ghost.inert = true;
  const list = scrollingList(card);
  const style = source && getComputedStyle(source);
  return {
    from: source &&
      style && {
        rect: within(source, card),
        radius: style.borderTopLeftRadius,
        inset: style.paddingInlineStart,
      },
    height: card.offsetHeight,
    ghost,
    list,
    rows: new Map([...(list?.children ?? [])].map((row) => [row, row.getBoundingClientRect().top])),
  };
}

/** The answer's clone flying from its tile or field into the bubble, which stays hidden meanwhile. */
function launch(
  land: HTMLElement,
  layer: HTMLElement,
  from: NonNullable<Departure["from"]>,
  to: Rect,
  timing: KeyframeAnimationOptions,
) {
  const rest = getComputedStyle(land);
  const clone = document.createElement("div");
  clone.dataset.askFlight = "";
  clone.className =
    "absolute flex items-center overflow-hidden bg-chat-user text-body text-chat-user-foreground";
  const text = document.createElement("div");
  const [padTop, padRight, padBottom, padLeft] = [
    rest.paddingTop,
    rest.paddingRight,
    rest.paddingBottom,
    rest.paddingLeft,
  ].map(Number.parseFloat) as [number, number, number, number];
  // One line stays one line while the label thins from the tile's weight to the bubble's.
  const oneLine = to.height - padTop - padBottom < Number.parseFloat(rest.lineHeight) * 1.5;
  text.className = oneLine ? "shrink-0 whitespace-pre" : "shrink-0 whitespace-pre-wrap break-words";
  text.style.width = `${to.width - padLeft - padRight}px`;
  text.innerHTML = land.innerHTML;
  clone.append(text);
  layer.append(clone);
  land.style.visibility = "hidden";
  return {
    clone,
    animations: [
      clone.animate([frame(from.rect, from.radius), frame(to, rest.borderTopLeftRadius)], {
        ...timing,
        fill: "forwards",
      }),
      text.animate(
        [
          { marginInlineStart: from.inset, fontWeight: 500 },
          { marginInlineStart: rest.paddingInlineStart, fontWeight: 400 },
        ],
        { ...timing, fill: "forwards" },
      ),
    ],
  };
}

/**
 * One movement, on one spring: the card already has its settled layout, so the list's rows slide
 * from where they stood to their new places, the answer flies from its tile into its bubble (or the
 * bubble rises from the card's foot when a button sent it), and the old card folds away under a
 * clip. Returns the cancel.
 */
export function fly(
  card: HTMLElement,
  layer: HTMLElement,
  { from, height, ghost, list, rows }: Departure,
) {
  const land = card.querySelector<HTMLElement>('[data-slot="user-bubble"]');
  const settled = card.lastElementChild;
  if (!land || !settled) return () => {};
  // The settled card is shorter, so the list may clamp its scroll and move the row it anchors
  // to; anchored from there, the next reply would jump the thread back.
  list?.style.setProperty("overflow-anchor", "none");
  const to = within(land, card);
  const timing = { duration: motion.flight, easing: springEasing };
  const view = list?.getBoundingClientRect();
  const slides = [...rows].flatMap(([row, top]) => {
    const now = row.getBoundingClientRect();
    const shift = top - now.top;
    const seen = (y: number) => !view || (y < view.bottom && y + now.height > view.top);
    if (Math.abs(shift) < 0.5 || !(seen(top) || seen(now.top))) return [];
    return [row.animate([{ transform: `translateY(${shift}px)` }, { transform: "none" }], timing)];
  });
  layer.append(ghost);
  const fold = layer.animate(
    [{ height: `${height}px` }, { height: `${card.offsetHeight}px` }],
    timing,
  );
  const flight = from
    ? launch(land, layer, from, to, timing)
    : {
        clone: null,
        animations: [
          land.animate(
            [{ transform: `translateY(${height - to.top - to.height}px)` }, { transform: "none" }],
            timing,
          ),
          land.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: motion.fill,
            easing: motion.ease,
          }),
        ],
      };
  const animations = [
    ...slides,
    fold,
    ...flight.animations,
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: motion.fill, fill: "forwards" }),
    settled.firstElementChild?.animate(
      [{ opacity: 0 }, { opacity: 0, offset: motion.fill / motion.flight }, { opacity: 1 }],
      { duration: motion.flight, easing: motion.ease },
    ),
  ];
  const end = () => {
    for (const animation of animations) animation?.cancel();
    ghost.remove();
    flight.clone?.remove();
    land.style.visibility = "";
    list?.style.removeProperty("overflow-anchor");
    window.removeEventListener("resize", end);
  };
  // The flight aims at where the bubble stood when it left; a resize moves it, so it snaps there.
  window.addEventListener("resize", end);
  fold.finished.then(end, () => {});
  return end;
}

const LINE = '[data-slot="stack-line"]';
const STEP =
  '[data-slot="stack-step"], [data-slot="framed-block-body"], [data-slot="framed-block-actions"]';

/**
 * A stack moving to another question: what changes fades out, then the card springs to its new
 * height while the next question and the newly folded line fade in. Nothing moves with reduced motion.
 */
export function advance(card: HTMLElement | null, apply: () => void, still: boolean) {
  const block = card?.querySelector<HTMLElement>('[data-slot="framed-block"]');
  if (!block || still) return apply();
  const kept = new Set(block.querySelectorAll(LINE));
  const out = [...block.querySelectorAll(STEP)].map((element) =>
    element.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: motion.stepOut,
      easing: motion.ease,
      fill: "forwards",
    }),
  );
  const swap = () => {
    const from = block.offsetHeight;
    flushSync(apply);
    const incoming = [
      ...block.querySelectorAll(STEP),
      ...[...block.querySelectorAll(LINE)].filter((line) => !kept.has(line)),
    ];
    for (const element of incoming) {
      element.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: motion.stepIn,
        easing: motion.ease,
      });
    }
    for (const animation of out) animation.cancel();
    block.animate([{ height: `${from}px` }, { height: `${block.offsetHeight}px` }], {
      duration: motion.flight,
      easing: springEasing,
    });
  };
  Promise.all(out.map((animation) => animation.finished)).then(swap, swap);
}
