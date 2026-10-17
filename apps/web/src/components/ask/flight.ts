import type { CommitSource } from "@rakazo/core";
import { motion, springAt, springEasing } from "@rakazo/ui-tokens";
import { flushSync } from "react-dom";
import { transcriptEnd } from "../../lib/transcript-scroll";

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
/** What a stack's last move left fading over the card. */
const GHOST = "[data-ask-ghost]";
/** The frame each list's reveal scroll waits for. */
const reveals = new WeakMap<Element, number>();

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

export type Steady = { carry: () => void; stop: () => void };

/**
 * From the commit until the answer lands, the thread keeps to its end as the working line or a reply
 * lands under the card, which moves the list's scroll at once. Until the flight starts the rows hold
 * their place on screen and the flight carries them from there; once it flies they glide to their new
 * place on the spring. Either way the follow joins the movement instead of jumping.
 */
export function steady(card: HTMLElement): Steady {
  const list = scrollingList(card);
  if (!list) return { carry() {}, stop() {} };
  let top = list.scrollTop;
  let holds: Animation[] = [];
  let flying = false;
  const follow = () => {
    const by = list.scrollTop - top;
    top = list.scrollTop;
    // A person scrolling away from the end keeps their own scroll.
    if (Math.abs(by) < 0.5 || transcriptEnd(list) - top > 1) return;
    const view = list.getBoundingClientRect();
    const seen = (y: number, height: number) => y < view.bottom && y + height > view.top;
    for (const row of list.children) {
      const now = row.getBoundingClientRect();
      if (!(seen(now.top, now.height) || seen(now.top + by, now.height))) continue;
      const from = { transform: `translateY(${by}px)` };
      if (flying) {
        row.animate([from, { transform: "translateY(0)" }], {
          duration: motion.flight,
          easing: springEasing,
          composite: "add",
        });
      } else {
        holds.push(row.animate([from, from], { duration: Infinity, composite: "add" }));
      }
    }
  };
  const release = () => {
    for (const hold of holds) hold.cancel();
    holds = [];
  };
  list.addEventListener("scroll", follow);
  return {
    /** The flight measured the rows where they were held: it carries them from there. */
    carry() {
      release();
      flying = true;
      top = list.scrollTop;
    },
    stop() {
      list.removeEventListener("scroll", follow);
      release();
    },
  };
}

/** Measures the card and the list it sits in, before the card settles. */
export function departure(card: HTMLElement, leaving: CommitSource): Departure | null {
  const selector = leaving.kind === "button" ? null : SOURCE[leaving.kind];
  const source = selector ? card.querySelector(selector) : null;
  const content = card.lastElementChild;
  if ((selector && !source) || !content) return null;
  const ghost = content.cloneNode(true) as HTMLElement;
  for (const element of ghost.querySelectorAll(GHOST)) element.remove();
  if (selector)
    ghost.querySelector<HTMLElement>(selector)?.style.setProperty("visibility", "hidden");
  for (const element of ghost.querySelectorAll("[id]")) element.removeAttribute("id");
  ghost.inert = true;
  const list = scrollingList(card);
  // A reveal still scrolling would move the rows after they are measured.
  if (list) cancelAnimationFrame(reveals.get(list) ?? 0);
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
  held: Steady,
) {
  const land = card.querySelector<HTMLElement>('[data-slot="user-bubble"]');
  const settled = card.lastElementChild;
  if (!land || !settled) {
    held.stop();
    return () => {};
  }
  // The settled card is shorter, so the list may clamp its scroll and move the row it anchors
  // to; anchored from there, the next reply would jump the thread back.
  list?.style.setProperty("overflow-anchor", "none");
  held.carry();
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
          // Only once the old card has faded, so the two never show at once.
          land.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: motion.fill,
            delay: motion.fill,
            easing: motion.ease,
            fill: "backwards",
          }),
        ],
      };
  const animations = [
    ...slides,
    fold,
    ...flight.animations,
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: motion.fill, fill: "forwards" }),
    settled.firstElementChild?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: motion.flight - motion.fill,
      delay: motion.fill,
      easing: motion.ease,
      fill: "backwards",
    }),
  ];
  const end = () => {
    for (const animation of animations) animation?.cancel();
    ghost.remove();
    flight.clone?.remove();
    land.style.visibility = "";
    list?.style.removeProperty("overflow-anchor");
    held.stop();
    window.removeEventListener("resize", end);
  };
  // The flight aims at where the bubble stood when it left; a resize moves it, so it snaps there.
  window.addEventListener("resize", end);
  fold.finished.then(end, () => {});
  return end;
}

const LINE = '[data-slot="stack-line"]';
/** What stays across a move, the folded lines and the card's detail: it slides, never fades. */
const KEPT = `${LINE}, [data-slot="framed-block-consequence"]`;
const STEP =
  '[data-slot="stack-step"], [data-slot="framed-block-body"], [data-slot="framed-block-actions"]';

/**
 * A stack moving to another question, in place: the old question fades out over the new one while
 * the card springs to its new height and the lines it keeps slide to their places. A newly folded
 * line shows once the old question is gone, so no answer shows twice. Nothing moves with reduced
 * motion.
 */
export function advance(card: HTMLElement | null, apply: () => boolean, still: boolean) {
  const block = card?.querySelector<HTMLElement>('[data-slot="framed-block"]');
  if (!block || still) return void apply();
  for (const old of block.querySelectorAll(`:scope > ${GHOST}`)) old.remove();
  const from = block.offsetHeight;
  const list = scrollingList(block);
  const scrolled = list?.scrollTop ?? 0;
  const inBlock = (element: Element) =>
    element.getBoundingClientRect().top - block.getBoundingClientRect().top;
  const kept = new Map([...block.querySelectorAll(KEPT)].map((el) => [el, inBlock(el)]));
  const ghost = document.createElement("div");
  ghost.dataset.askGhost = "";
  ghost.inert = true;
  ghost.ariaHidden = "true";
  ghost.className = "pointer-events-none absolute inset-x-0 top-0";
  for (const child of block.children) ghost.append(child.cloneNode(true));
  const clones = ghost.querySelectorAll<HTMLElement>(KEPT);
  const copies = new Map([...kept.keys()].map((el, index) => [el, clones[index]]));
  // A picture of the old question: nothing that finds the card's parts finds it.
  for (const element of ghost.querySelectorAll("[id], [data-slot]")) {
    element.removeAttribute("id");
    element.removeAttribute("data-slot");
  }
  if (!flushSync(apply)) return;
  const timing = { duration: motion.flight, easing: springEasing };
  const fresh = [...block.querySelectorAll(LINE)].filter((line) => !kept.has(line));
  for (const element of block.querySelectorAll(STEP)) {
    element.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: motion.stepIn,
      easing: motion.ease,
    });
  }
  for (const line of fresh) {
    line.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: motion.stepIn,
      delay: motion.stepOut,
      easing: motion.ease,
      fill: "backwards",
    });
  }
  block.append(ghost);
  block.animate([{ height: `${from}px` }, { height: `${block.offsetHeight}px` }], timing);
  // A card that got shorter made the list clamp its scroll at once; back at its old height, the
  // list takes its scroll back and gives it up along the spring.
  if (list) list.scrollTop = scrolled;
  for (const [element, top] of kept) {
    if (!element.isConnected) continue;
    copies.get(element)?.style.setProperty("visibility", "hidden");
    const shift = top - inBlock(element);
    if (Math.abs(shift) >= 0.5) {
      element.animate([{ transform: `translateY(${shift}px)` }, { transform: "none" }], timing);
    }
  }
  ghost
    .animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: motion.stepOut,
      easing: motion.ease,
      fill: "forwards",
    })
    .finished.finally(() => ghost.remove())
    .catch(() => {});
}

/**
 * When the card is in view but its foot is not, scrolls its list on the spring until the foot is,
 * without taking the current question out of view; the lines above it may go. Called as the card
 * grows, so both move on the same curve.
 */
export function reveal(block: HTMLElement, still: boolean) {
  const list = scrollingList(block);
  if (!list) return;
  const view = list.getBoundingClientRect();
  const { top } = block.getBoundingClientRect();
  if (top >= view.bottom || top + block.offsetHeight <= view.top) return;
  const room = Number.parseFloat(getComputedStyle(list).paddingBottom) || 0;
  const question = block.querySelector('[data-slot="stack-step"]') ?? block;
  const by = Math.min(
    top + block.offsetHeight + room - view.bottom,
    question.getBoundingClientRect().top - view.top,
  );
  if (by < 1) return;
  const from = list.scrollTop;
  cancelAnimationFrame(reveals.get(list) ?? 0);
  if (still) {
    list.scrollTop = from + by;
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const elapsed = Math.min(now - start, motion.flight);
    list.scrollTop = from + by * springAt(elapsed);
    if (elapsed < motion.flight) reveals.set(list, requestAnimationFrame(step));
  };
  reveals.set(list, requestAnimationFrame(step));
}
