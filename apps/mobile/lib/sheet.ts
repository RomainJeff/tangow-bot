import type { ReactNode } from "react";

type SheetRender = (close: () => void) => ReactNode;

let content: SheetRender | null = null;
let owner: string | null = null;
let closeOpen: (() => void) | null = null;

/**
 * Presents `render` in the native sheet route (`app/sheet.tsx`). The screen
 * that opens it keeps the state and handlers; the route only presents them.
 * `sheetOwner` lets that screen close its own sheet later with `closeSheet`.
 */
export function openSheet(
  router: { push: (href: "/sheet") => void },
  render: SheetRender,
  sheetOwner: string | null = null,
): void {
  content = render;
  owner = sheetOwner;
  router.push("/sheet");
}

export function sheetContent(): SheetRender | null {
  return content;
}

export function registerSheetClose(close: () => void): () => void {
  closeOpen = close;
  return () => {
    if (closeOpen !== close) return;
    closeOpen = null;
    content = null;
    owner = null;
  };
}

/** Closes the open sheet if `sheetOwner` opened it. */
export function closeSheet(sheetOwner: string): void {
  if (owner === sheetOwner) closeOpen?.();
}
