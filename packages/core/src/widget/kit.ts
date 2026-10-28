export const WIDGET_KIT_CSS = `
* { box-sizing: border-box; }
body {
  display: flow-root; margin: 0; padding: 16px; background: transparent; color: var(--foreground);
  font-family: -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  font-size: var(--type-body-size); line-height: var(--type-body-leading);
  letter-spacing: var(--type-body-tracking); font-weight: var(--type-body-weight);
}
h1, h2, h3, h4 { margin: 0 0 12px; font-weight: var(--type-title-weight); line-height: var(--type-title-leading); }
h1 { font-size: var(--type-question-size); }
h2 { font-size: var(--type-title-size); }
h3, h4 { font-size: var(--type-row-name-size); }
p, ul, ol { margin: 0 0 12px; }
ul, ol { padding-inline-start: 24px; }
a { color: var(--foreground); text-underline-offset: 3px; }
small { font-size: var(--type-meta-size); }
hr { border: 0; border-top: 1px solid var(--border); margin: 16px 0; }
img, video { max-width: 100%; height: auto; border-radius: var(--corner-row); }
audio { max-width: 100%; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 12px; text-align: start; border-bottom: 1px solid var(--border); }
th { font-weight: var(--type-label-weight); }
button { font: inherit; cursor: pointer; }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.stack { display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.card { border: 1px solid var(--border); border-radius: var(--corner-card); padding: 16px; }
.muted { color: var(--muted-foreground); }
.badge { display: inline-flex; align-items: center; padding: 4px 8px; border-radius: 9999px;
  background: var(--mention-chip); color: var(--mention-chip-foreground);
  font-size: var(--type-label-size); line-height: var(--type-label-leading); font-weight: var(--type-label-weight); }
.button { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 8px 16px;
  border: 1px solid transparent; border-radius: 9999px; text-decoration: none;
  background: var(--primary); color: var(--primary-foreground); }
.button.secondary { background: var(--secondary); color: var(--secondary-foreground); border-color: var(--border); }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px; border-radius: 9999px; background: var(--mention-chip); }
.tabs button[role="tab"] { border: 0; border-radius: 9999px; background: transparent; color: var(--foreground); padding: 8px 16px; }
.tabs button[role="tab"][aria-selected="true"] { background: var(--surface); }
.stat .value { font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; }
.stat .label { color: var(--muted-foreground); font-size: var(--type-meta-size); }
.media { margin: 0; }
.media img, .media video { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; }
.media figcaption { margin-top: 8px; color: var(--muted-foreground); font-size: var(--type-meta-size); }
[hidden] { display: none !important; }
@media (max-width: 480px) { body { padding: 12px; } .grid { grid-template-columns: 1fr; } }
`;
