import type { RefObject } from "react";
import { useEffect, useRef } from "react";

/**
 * Focus follows a pushed page: onto its back button when a section opens, back to
 * the `data-opens` row that opened it when the list returns. Attach the returned
 * ref to the section's BackCapsule; `root` holds the list rows.
 */
export function usePushedFocus(section: string | null, root: RefObject<HTMLElement | null>) {
  const backButton = useRef<HTMLButtonElement>(null);
  const last = useRef(section);
  useEffect(() => {
    const previous = last.current;
    last.current = section;
    if (previous === section) return;
    if (section) backButton.current?.focus();
    else root.current?.querySelector<HTMLElement>(`[data-opens="${previous}"]`)?.focus();
  }, [section, root]);
  return backButton;
}
