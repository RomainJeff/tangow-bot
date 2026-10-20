import type { MessageBlock } from "@rakazo/contracts";
import type { ProgressLayer } from "./session-log/project-thread-view.js";

export function isToolActivityBlock(block: MessageBlock): boolean {
  return block.kind === "steps" || (block.kind === "progress" && block.activity === true);
}

/** The tool activity line a run is on right now — `Reading a file`,
    `Writing a reply` — for the working-state label. Undefined when the run
    is between tools, or when it is narrating text the transcript already shows.
    Read from the live layer: a live row holding only that line draws nothing,
    so the transcript's rows never carry it. */
export function latestActivityLabel(layer: ProgressLayer): string | undefined {
  const tail = [...layer.values()].at(-1)?.blocks.at(-1);
  if (tail?.kind !== "progress" || tail.activity !== true) return undefined;
  return tail.text.trim() === "" ? undefined : tail.text.trim();
}
