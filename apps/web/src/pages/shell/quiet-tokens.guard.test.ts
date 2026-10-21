import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The "Quiet" thread components compose design-system tokens, never a hand-sized
// value that already has a token. This guard locks that in for the files the
// tokenisation pass cleaned, so the debt does not creep back the moment a new
// `text-[13px]` or `rounded-[14px]` is pasted in. It does NOT yet cover the
// shell's forms and dialogs (bot-panel, dialogs, command-palette, bot-picker)
// or the wider app (settings, teach, integrations), which still carry legacy
// arbitrary values — those are a separate, larger pass.

const shell = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(shell, "../..");

const GUARDED = [
  "pages/shell/composer.tsx",
  "pages/shell/composer-attachments.tsx",
  "pages/shell/composer-dictation.tsx",
  "pages/shell/composer-notices.tsx",
  "pages/shell/composer-pickers.tsx",
  "pages/shell/message-cards.tsx",
  "pages/shell/side-panel.tsx",
  "pages/shell/screen-frame.tsx",
  "pages/shell/message-view.tsx",
  "pages/shell/transcript.tsx",
  "pages/shell/jump-to-latest.tsx",
  "pages/shell/sidebar.tsx",
  "pages/shell/sidebar-header.tsx",
  "pages/shell/sidebar-roster.tsx",
  "pages/shell/sidebar-footer.tsx",
  "pages/shell/thread-header.tsx",
  "pages/shell/message-hover-actions.tsx",
  "pages/shell/message-actions-sheet.tsx",
  "components/AgentSteps.tsx",
  "components/AskCard.tsx",
];

// The only arbitrary type/radius values kept on purpose, because no token fits:
// the 9px count badge on a composer chip, and the data-driven 3px chart swatch.
const ALLOWED_ARBITRARY = new Set(["text-[9px]", "rounded-[3px]"]);

// Glyphs that are only ever used as an icon (never copy): a drawn lucide icon
// must stand in instead. `→`/`✓` are excluded here since they occur in prose.
const ICON_GLYPHS = ["◷", "›", "☑", "☐", "▸", "▾"];

describe("Quiet thread components stay on the token scale", () => {
  for (const rel of GUARDED) {
    it(`${rel} uses tokens, not tokenable arbitrary values`, () => {
      const src = readFileSync(path.join(srcDir, rel), "utf8");

      const arbitraryType = src.match(/text-\[[^\]]+\]/g) ?? [];
      const arbitraryRadius = src.match(/rounded-\[[^\]]+\]/g) ?? [];
      const offenders = [...arbitraryType, ...arbitraryRadius].filter(
        (token) => !ALLOWED_ARBITRARY.has(token),
      );
      expect(offenders, `use a text-*/rounded-* token instead of ${offenders.join(", ")}`).toEqual(
        [],
      );

      // A raw white fill is a card surface; use bg-card / bg-surface.
      expect(src.includes("bg-white"), "use bg-card / bg-surface, not bg-white").toBe(false);

      const glyphs = ICON_GLYPHS.filter((glyph) => src.includes(glyph));
      expect(glyphs, `use a lucide icon instead of the glyph(s) ${glyphs.join(" ")}`).toEqual([]);
    });
  }
});
