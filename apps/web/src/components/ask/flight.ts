import { motion, springEasing } from "@rakazo/ui-tokens";

type Rect = { left: number; top: number; width: number; height: number };

/** The filled tile or field an answer leaves from, taken from the card just before it settles. */
export type Departure = {
  from: Rect;
  radius: string;
  inset: string;
  height: number;
  ghost: Element;
  list: HTMLElement | null;
  /** Where each row of the list stood, to slide it from there to its new place. */
  rows: Map<Element, number>;
};

const SOURCE = '[aria-pressed="true"], [data-slot="option-field"]';

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
export function departure(card: HTMLElement): Departure | null {
  const source = card.querySelector(SOURCE);
  const content = card.lastElementChild;
  if (!source || !content) return null;
  const style = getComputedStyle(source);
  const ghost = content.cloneNode(true) as HTMLElement;
  ghost.querySelector<HTMLElement>(SOURCE)?.style.setProperty("visibility", "hidden");
  for (const element of ghost.querySelectorAll("[id]")) element.removeAttribute("id");
  ghost.inert = true;
  const list = scrollingList(card);
  return {
    from: within(source, card),
    radius: style.borderTopLeftRadius,
    inset: style.paddingInlineStart,
    height: card.offsetHeight,
    ghost,
    list,
    rows: new Map([...(list?.children ?? [])].map((row) => [row, row.getBoundingClientRect().top])),
  };
}

/**
 * One movement, on one spring: the card already has its settled layout, so the list's rows slide
 * from where they stood to their new places, the answer flies from its tile into its bubble, and
 * the old card folds away under a clip. Returns the cancel.
 */
export function fly(
  card: HTMLElement,
  layer: HTMLElement,
  { from, radius, inset, height, ghost, list, rows }: Departure,
) {
  const land = card.querySelector<HTMLElement>('[data-slot="user-bubble"]');
  const settled = card.lastElementChild;
  if (!land || !settled) return () => {};
  // The settled card is shorter, so the list may clamp its scroll and move the row it anchors
  // to; anchored from there, the next reply would jump the thread back.
  list?.style.setProperty("overflow-anchor", "none");
  const to = within(land, card);
  const rest = getComputedStyle(land);
  const timing = { duration: motion.flight, easing: springEasing };
  const view = list?.getBoundingClientRect();
  const slides = [...rows].flatMap(([row, top]) => {
    const now = row.getBoundingClientRect();
    const shift = top - now.top;
    const seen = (y: number) => !view || (y < view.bottom && y + now.height > view.top);
    if (Math.abs(shift) < 0.5 || !(seen(top) || seen(now.top))) return [];
    return [row.animate([{ transform: `translateY(${shift}px)` }, { transform: "none" }], timing)];
  });
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
  layer.append(ghost, clone);
  land.style.visibility = "hidden";
  const fold = layer.animate(
    [{ height: `${height}px` }, { height: `${card.offsetHeight}px` }],
    timing,
  );
  const animations = [
    ...slides,
    fold,
    clone.animate([frame(from, radius), frame(to, rest.borderTopLeftRadius)], {
      ...timing,
      fill: "forwards",
    }),
    text.animate(
      [
        { marginInlineStart: inset, fontWeight: 500 },
        { marginInlineStart: rest.paddingInlineStart, fontWeight: 400 },
      ],
      { ...timing, fill: "forwards" },
    ),
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: motion.fill, fill: "forwards" }),
    settled.firstElementChild?.animate(
      [{ opacity: 0 }, { opacity: 0, offset: motion.fill / motion.flight }, { opacity: 1 }],
      { duration: motion.flight, easing: motion.ease },
    ),
  ];
  const end = () => {
    for (const animation of animations) animation?.cancel();
    ghost.remove();
    clone.remove();
    land.style.visibility = "";
    list?.style.removeProperty("overflow-anchor");
  };
  fold.finished.then(end, () => {});
  return end;
}
