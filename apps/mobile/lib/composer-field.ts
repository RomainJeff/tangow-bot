import { sizes } from "@rakazo/ui-tokens";

/** How long an emptied field gets to shrink on its own before it is rebuilt. */
export const COMPOSER_SHRINK_GRACE_MS = 150;

// Half a 22 pt line: past this the field is on a second line, not rounding noise.
const EXTRA_LINE_SLACK = 11;

/**
 * An iOS multiline field that a programmatic `value=""` empties without
 * shrinking keeps its old height. True when the draft is empty but the last
 * measured field height is still above the one-line capsule.
 */
export function composerFieldStuckTall(draft: string, fieldHeight: number | null): boolean {
  return (
    draft === "" && fieldHeight !== null && fieldHeight >= sizes.composerTarget + EXTRA_LINE_SLACK
  );
}
