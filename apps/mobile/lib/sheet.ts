import type { ReactNode } from "react";
import type { ColorValue } from "react-native";

type SheetRender = (close: () => void) => ReactNode;

type SheetOptions = {
  /** Lets the opener close its own sheet later with `closeSheet`. */
  owner?: string;
  /** Fills the whole native sheet, grabber and home-indicator area included. */
  background: ColorValue;
};

let content: { render: SheetRender; background: ColorValue } | null = null;
let owner: string | null = null;
let closeOpen: (() => void) | null = null;

/**
 * Presents `render` in the native sheet route (`app/sheet.tsx`). The screen
 * that opens it keeps the state and handlers; the route only presents them.
 */
export function openSheet(
  router: { push: (href: "/sheet") => void },
  render: SheetRender,
  options: SheetOptions,
): void {
  content = { render, background: options.background };
  owner = options.owner ?? null;
  router.push("/sheet");
}

export function sheetContent(): typeof content {
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
