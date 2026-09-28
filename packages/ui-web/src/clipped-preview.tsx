import { Maximize2 } from "lucide-react";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "./lib/utils.js";

/** One line of the 23 px body — the same rule of thumb as the mobile `ClippedPreview`. */
const LINE_HEIGHT_PX = 23;

export interface ClippedPreviewProps {
  /**
   * The raw text (markdown source, plain text) the rendered `children` are
   * worth: its line count is the first guess (server render, first paint).
   * Once laid out, the content's real height decides, so a long wrapped
   * paragraph is cut too. Never rendered itself.
   */
  text: string;
  /** Cut to this many lines when it hides at least three more (8 for a
   * routine report, 5 for a task result). */
  maxLines: number;
  /** Tailwind `from-*` class the fade blends into — the host's own fill. */
  fadeFrom: string;
  /**
   * Opens the rest of the content (a Dialog). Omit it when an ancestor is
   * already the click target — a task card opens itself whole, so its own
   * clipped result has no button of its own nested inside that one (native
   * `<button>` cannot nest); the fade and badge then stay purely visual.
   */
  onOpen?: () => void;
  /** Accessible name for the button — required together with `onOpen`. A
   * primitive holds no copy, so the caller composes it, hint included:
   * "Report, {name} · Opens in full". */
  ariaLabel?: string;
  children: ReactNode;
}

/**
 * Content cut to `maxLines` when it runs longer, only when that hides at
 * least three more lines: its last lines fade into the host and a round
 * expand badge sits on the fade, bottom end. The badge only marks it; the
 * whole preview is the target and opens the rest — unless `onOpen` is
 * omitted, in which case the fade and badge are decoration only and a click
 * anywhere on the page must come from an ancestor instead. Content that fits
 * renders as is, with no fade and no badge.
 */
export function ClippedPreview({
  text,
  maxLines,
  fadeFrom,
  onOpen,
  ariaLabel,
  children,
}: ClippedPreviewProps) {
  const content = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const limit = (maxLines + 3) * LINE_HEIGHT_PX;
    const measure = () => setMeasured(element.scrollHeight > limit);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [maxLines]);
  const capped = measured ?? text.split("\n").length > maxLines + 3;
  if (!capped) {
    return (
      <div data-slot="clipped-preview" data-capped="false">
        <div ref={content}>{children}</div>
      </div>
    );
  }
  const fade = (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-linear-to-t to-transparent",
        fadeFrom,
      )}
    />
  );
  const badge = (
    <span
      aria-hidden="true"
      className="absolute end-2 bottom-2 grid size-hover-icon place-items-center rounded-full border border-outline bg-secondary text-secondary-foreground"
    >
      <Maximize2 className="size-3.5" strokeWidth={1.8} />
    </span>
  );
  const style = { maxHeight: maxLines * LINE_HEIGHT_PX };
  if (!onOpen) {
    return (
      <div
        data-slot="clipped-preview"
        data-capped="true"
        className="relative overflow-hidden"
        style={style}
      >
        <div ref={content} aria-hidden="true">
          {children}
        </div>
        {fade}
        {badge}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-slot="clipped-preview"
      data-capped="true"
      onClick={onOpen}
      aria-label={ariaLabel}
      className="relative block w-full overflow-hidden text-start"
      style={style}
    >
      <div aria-hidden="true">{children}</div>
      {fade}
      {badge}
    </button>
  );
}
