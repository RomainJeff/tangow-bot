/**
 * Widget design system: plain document UI on the app's colors, type and spacing, shaped like the
 * shadcn primitives (card, badge, button, tabs) rather than chat chrome. Radii derive from
 * `--radius` as shadcn does; only generic semantic tokens are used.
 */
export const WIDGET_KIT_CSS = `
* { box-sizing: border-box; }
body {
  display: flow-root; margin: 0; padding: 16px; background: transparent; color: var(--foreground);
  font-family: -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  font-size: 15px; line-height: 1.5; letter-spacing: -0.01em;
}
h1, h2, h3, h4 { margin: 0 0 12px; font-weight: 600; line-height: 1.3; letter-spacing: -0.015em; }
h1 { font-size: 22px; }
h2 { font-size: 17px; }
h3, h4 { font-size: 15px; }
p, ul, ol { margin: 0 0 12px; }
:is(h1, h2, h3, h4, p, ul, ol):last-child { margin-bottom: 0; }
ul, ol { padding-inline-start: 24px; }
a { color: var(--foreground); text-underline-offset: 3px; }
small { font-size: 13px; }
hr { border: 0; border-top: 1px solid var(--border); margin: 16px 0; }
img, video { display: block; max-width: 100%; height: auto; border-radius: calc(var(--radius) - 4px); }
audio { max-width: 100%; }
figure { margin: 0; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0 0 12px; }
dl:last-child { margin-bottom: 0; }
dt { color: var(--muted-foreground); }
dd { margin: 0; }
table { width: 100%; border-collapse: collapse; font-size: 14px; font-variant-numeric: tabular-nums; }
th, td { padding: 8px 12px; text-align: start; border-bottom: 1px solid var(--border); }
th { color: var(--muted-foreground); font-size: 13px; font-weight: 500; }
button { font: inherit; color: inherit; cursor: pointer; }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.stack { display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.card {
  display: flex; flex-direction: column; gap: 8px; padding: 16px; border: 1px solid var(--border);
  border-radius: var(--radius); background: var(--card); color: var(--card-foreground);
}
.muted { color: var(--muted-foreground); }
.badge {
  display: inline-flex; align-items: center; width: fit-content; height: 22px; padding: 0 8px; border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 6px); color: var(--foreground); font-size: 12px; font-weight: 500;
}
.button {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px;
  padding: 0 16px; border: 1px solid transparent; border-radius: calc(var(--radius) - 4px);
  background: var(--primary); color: var(--primary-foreground); font-size: 14px; font-weight: 500;
  text-decoration: none; transition: opacity var(--duration-hover) var(--motion-ease);
}
.button:hover { opacity: 0.85; }
.button.secondary { background: transparent; color: var(--foreground); border-color: var(--border); }
.button:disabled { opacity: 0.5; cursor: default; }
.tabs {
  display: inline-flex; max-width: 100%; gap: 2px; padding: 3px; overflow-x: auto;
  border-radius: calc(var(--radius) - 4px); background: var(--muted);
}
.tabs button[role="tab"] {
  flex: 0 0 auto; min-height: 38px; padding: 0 12px; border: 0; border-radius: calc(var(--radius) - 6px);
  background: transparent; color: var(--muted-foreground); font-size: 14px; font-weight: 500;
}
.tabs button[role="tab"][aria-selected="true"] { background: var(--background); color: var(--foreground); }
.stat { display: flex; flex-direction: column; gap: 2px; }
.stat .value { font-size: 28px; line-height: 1.15; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.stat .label { color: var(--muted-foreground); font-size: 13px; }
.media img, .media video { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: var(--muted); }
.media figcaption { margin-top: 8px; color: var(--muted-foreground); font-size: 13px; }
figcaption a, .muted a { color: inherit; }
[hidden] { display: none !important; }
@media (max-width: 480px) { body { padding: 12px; } .grid { grid-template-columns: 1fr; } }
`;
