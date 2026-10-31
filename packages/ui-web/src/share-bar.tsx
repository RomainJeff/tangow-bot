import { cn } from "./lib/utils.js";

export interface ShareBarSegment {
  key: string;
  value: number;
  /** A bot's colour. Without one, segments take the ink ramp in order. */
  color?: string | null;
}

/** The ink ramp, heaviest first; the fourth shade carries every segment after it. */
const INK = ["bg-foreground", "bg-muted-foreground", "bg-foreground-subtle", "bg-input"] as const;

/** One bar split in proportion to its segments. Decorative: the list beside it carries the numbers. */
export function ShareBar({
  segments,
  className,
}: {
  segments: readonly ShareBarSegment[];
  className?: string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const inked = segments.every((segment) => !segment.color);
  const shown =
    inked && segments.length > INK.length
      ? [
          ...segments.slice(0, INK.length - 1),
          {
            key: "rest",
            value: segments.slice(INK.length - 1).reduce((sum, segment) => sum + segment.value, 0),
          },
        ]
      : segments;
  return (
    <div
      aria-hidden
      data-slot="share-bar"
      className={cn("flex h-share-bar gap-px overflow-hidden rounded-full bg-muted", className)}
    >
      {total > 0
        ? shown.map((segment, index) => (
            <span
              key={segment.key}
              className={cn(
                "h-full basis-0 transition-[flex-grow] duration-(--duration-hover) ease-quiet",
                segment.color ? null : INK[Math.min(index, INK.length - 1)],
              )}
              style={{
                flexGrow: segment.value / total,
                ...(segment.color ? { backgroundColor: segment.color } : {}),
              }}
            />
          ))
        : null}
    </div>
  );
}

/** The ink class a list row's dot takes to match its segment. */
export function shareBarInk(index: number): string {
  return INK[Math.min(index, INK.length - 1)]!;
}
