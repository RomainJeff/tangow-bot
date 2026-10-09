import { useEffect } from "react";

/**
 * The side panel lies over the thread, which stays live behind it: Escape
 * closes it, a click outside does not. With an editor open on the bot page,
 * Escape closes the editor first. A key a field already used, to drop an edit,
 * is left alone, and `enabled` is false while a full-screen overlay or a call
 * owns the key.
 */
export function usePanelEscape({
  enabled,
  editorOpen,
  closeEditor,
  closePanel,
}: {
  enabled: boolean;
  editorOpen: boolean;
  closeEditor: () => void;
  closePanel: () => void;
}) {
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (editorOpen) closeEditor();
      else closePanel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled, editorOpen, closeEditor, closePanel]);
}
