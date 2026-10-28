import { renderTokensCss } from "@rakazo/ui-tokens/render-css";
import { WIDGET_KIT_CSS } from "./kit.js";

const WIDGET_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data: blob:; media-src https: data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

export function buildWidgetDocument({
  html,
  theme,
}: {
  html: string;
  theme: "light" | "dark";
}): string {
  return `<!doctype html><html data-theme="${theme}"><head><meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank"><style>${renderTokensCss()}\n${WIDGET_KIT_CSS}</style></head><body><script>
window.addEventListener("message", (event) => {
  if (event.source !== parent) return;
  let message = event.data;
  if (typeof message === "string") {
    try { message = JSON.parse(message); } catch { return; }
  }
  if (message && (message.rakazoWidgetTheme === "light" || message.rakazoWidgetTheme === "dark")) {
    document.documentElement.dataset.theme = message.rakazoWidgetTheme;
  }
});
document.addEventListener("DOMContentLoaded", () => {
  const sendHeight = () => {
    const message = JSON.stringify({ rakazoWidgetHeight: Math.ceil(document.body.getBoundingClientRect().height) });
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(message);
    else parent.postMessage(message, "*");
  };
  new ResizeObserver(sendHeight).observe(document.body);
  sendHeight();
});
</script>${html}</body></html>`;
}

export function parseWidgetHeightMessage(message: unknown): number | null {
  if (typeof message !== "string") return null;
  try {
    const value: unknown = JSON.parse(message);
    if (value && typeof value === "object" && "rakazoWidgetHeight" in value) {
      const height = value.rakazoWidgetHeight;
      if (typeof height === "number" && Number.isFinite(height) && height > 0) return height;
    }
  } catch {
    return null;
  }
  return null;
}
