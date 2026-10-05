// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClippedPreview } from "./clipped-preview.js";

type Observed = { element: Element; callback: () => void };
let observed: Observed[] = [];
/** Like the real one: only elements still in the page get notified. */
function resizeAll() {
  for (const { element, callback } of observed) if (element.isConnected) callback();
}

function stubLayout(size: { scrollHeight?: number; scrollWidth?: number; clientWidth?: number }) {
  for (const [key, value] of Object.entries(size)) {
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
  }
}

beforeEach(() => {
  observed = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe(element: Element) {
        observed.push({ element, callback: this.callback });
      }
      disconnect() {
        observed = observed.filter((entry) => entry.callback !== this.callback);
      }
    },
  );
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ["scrollHeight", "scrollWidth", "clientWidth"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
});

function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, root };
}

describe("ClippedPreview", () => {
  it("renders short content as is, with no fade and no badge", () => {
    const html = renderToString(
      <ClippedPreview
        text={"one\ntwo\nthree"}
        maxLines={8}
        fadeFrom="from-background"
        onOpen={() => {}}
        ariaLabel="Report, Accor watch"
      >
        <p>short report</p>
      </ClippedPreview>,
    );

    expect(html).toContain('data-capped="false"');
    expect(html).toContain("short report");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Maximize2".toLowerCase());
  });

  it("cuts content that hides at least three more lines, with a fade and an expand badge", () => {
    const longText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const html = renderToString(
      <ClippedPreview
        text={longText}
        maxLines={8}
        fadeFrom="from-background"
        onOpen={() => {}}
        ariaLabel="Report, Accor watch · Opens in full"
      >
        <p>long report</p>
      </ClippedPreview>,
    );

    expect(html).toContain('data-capped="true"');
    expect(html).toContain("<button");
    expect(html).toContain('aria-label="Report, Accor watch · Opens in full"');
    expect(html).toContain("bg-linear-to-t");
    expect(html).toContain("from-background");
    expect(html).toContain("long report");
  });

  it("stays decorative (no button) when onOpen is omitted, for a card that already opens itself", () => {
    const longText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const html = renderToString(
      <ClippedPreview text={longText} maxLines={5} fadeFrom="from-surface">
        <p>long result</p>
      </ClippedPreview>,
    );

    expect(html).toContain('data-capped="true"');
    expect(html).not.toContain("<button");
    expect(html).toContain("bg-linear-to-t");
    expect(html).toContain("long result");
  });

  it("does not cut when it would only hide the last line or two", () => {
    // maxLines(8) + 3 = 11: ten lines is not enough to cut.
    const almostLongText = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const html = renderToString(
      <ClippedPreview
        text={almostLongText}
        maxLines={8}
        fadeFrom="from-surface"
        onOpen={() => {}}
        ariaLabel="Task"
      >
        <p>ten lines</p>
      </ClippedPreview>,
    );

    expect(html).toContain('data-capped="false"');
    expect(html).not.toContain("<button");
  });

  it("measures the real content even when it opens on its own (button)", () => {
    stubLayout({ scrollHeight: 2 * 23 });
    const longText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const { container, root } = render(
      <ClippedPreview
        text={longText}
        maxLines={8}
        fadeFrom="from-surface"
        onOpen={() => {}}
        ariaLabel="Task"
      >
        <p>two short lines</p>
      </ClippedPreview>,
    );

    expect(container.querySelector('[data-capped="false"]')).toBeTruthy();
    act(() => root.unmount());
  });

  it("keeps measuring the content after capping swaps the wrapper", () => {
    stubLayout({ scrollHeight: 30 * 23 });
    const { container, root } = render(
      <ClippedPreview
        text="short"
        maxLines={8}
        fadeFrom="from-surface"
        onOpen={() => {}}
        ariaLabel="Task"
      >
        <p>grows</p>
      </ClippedPreview>,
    );
    expect(container.querySelector('[data-capped="true"]')).toBeTruthy();

    stubLayout({ scrollHeight: 2 * 23 });
    act(() => resizeAll());

    expect(container.querySelector('[data-capped="false"]')).toBeTruthy();
    act(() => root.unmount());
  });
});
