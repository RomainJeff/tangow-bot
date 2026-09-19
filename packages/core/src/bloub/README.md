# bloub

Vendored from <https://github.com/jeremy-prt/bloub> (`src/bot/`, commit `b4bb3c1b5f93c7b87a2e8d620f667c4093d97749`),
MIT License, Copyright (c) 2026 Jérémy Perret — see [LICENSE](./LICENSE).

Framework-free, clock-free bot engine: `new BotEngine(RAYON, "idle", radii)` then
`engine.sample(t)` returns a `BotFrame` in viewBox units (`DEMI_VIEWBOX`). The React renderer
lives in `@rakazo/ui-web` (`bot-avatar.tsx`). Only import paths (`.js` suffix) and formatting
were changed; keep it that way so upstream diffs stay readable.
