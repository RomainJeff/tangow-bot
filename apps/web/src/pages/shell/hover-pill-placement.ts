/** A box in viewport pixels, as `getBoundingClientRect` returns it. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Air between the pill and what it sits next to. */
const PILL_GAP_PX = 8;

/**
 * Where a row's hover pill goes, relative to the row's frame: beside the
 * bubble it acts on, on the side facing the thread's centre. Null keeps the
 * pill at its default top-end corner: a card, or a bubble too wide to leave
 * room beside it.
 */
export function hoverPillPlacement({
  frame,
  pill,
  bubble,
}: {
  frame: Box;
  pill: { width: number; height: number };
  /** The message's bubbles, united: the pill goes beside them. */
  bubble?: Box;
}): { x: number; y: number } | null {
  if (!bubble) return null;
  const roomAfter = frame.right - bubble.right;
  const roomBefore = bubble.left - frame.left;
  const needed = pill.width + PILL_GAP_PX;
  if (Math.max(roomAfter, roomBefore) < needed) return null;
  const x =
    roomAfter >= roomBefore
      ? bubble.right - frame.left + PILL_GAP_PX
      : bubble.left - frame.left - needed;
  // Centred on a one-line bubble, level with the first line of a taller one.
  const lineBox = Math.min(bubble.bottom - bubble.top, pill.height + PILL_GAP_PX);
  return { x, y: bubble.top - frame.top + (lineBox - pill.height) / 2 };
}

function union(elements: Iterable<Element>): Box | undefined {
  let box: Box | undefined;
  for (const element of elements) {
    const r = element.getBoundingClientRect();
    box = box
      ? {
          left: Math.min(box.left, r.left),
          top: Math.min(box.top, r.top),
          right: Math.max(box.right, r.right),
          bottom: Math.max(box.bottom, r.bottom),
        }
      : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  return box;
}

/**
 * Measures a transcript row and moves its pill (see `hoverPillPlacement`)
 * through `data-pill` and two CSS variables on the row, read by `HoverPill`.
 * Runs when the row is entered or focused, so a hover costs no re-render.
 */
export function placeHoverPill(row: HTMLElement): void {
  const frame = row.querySelector('[data-testid="message-bubble-frame"]');
  const pill = row.querySelector<HTMLElement>('[data-slot="hover-pill"]');
  if (!frame || !pill) return;
  const placement = hoverPillPlacement({
    frame: frame.getBoundingClientRect(),
    pill: { width: pill.offsetWidth, height: pill.offsetHeight },
    // A message that is only a link has no bubble: the pill goes beside its card.
    bubble: union(
      row.querySelector('[data-slot="message-row-bubble"]')
        ? row.querySelectorAll('[data-slot="message-row-bubble"]')
        : row.querySelectorAll('[data-slot="link-preview-card"]'),
    ),
  });
  if (!placement) {
    delete row.dataset.pill;
    return;
  }
  // `HoverPill` reads the offset from its inline start: the right edge in RTL.
  const x =
    getComputedStyle(row).direction === "rtl"
      ? frame.getBoundingClientRect().width - placement.x - pill.offsetWidth
      : placement.x;
  row.dataset.pill = "beside";
  row.style.setProperty("--pill-x", `${Math.round(x)}px`);
  row.style.setProperty("--pill-y", `${Math.round(placement.y)}px`);
}
