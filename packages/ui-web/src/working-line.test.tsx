// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkingLine } from "./working-line.js";

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

describe("WorkingLine", () => {
  it("announces what the bot is doing, with a monospaced duration", () => {
    const html = renderToString(
      <WorkingLine avatar={<span>avatar</span>} label="Maya is drafting the recap" />,
    );

    expect(html).toContain('data-slot="working-line"');
    expect(html).toContain('role="status"');
    expect(html).toContain("text-working");
    expect(html).toContain("font-mono");
    expect(html).toContain("text-mono");
    expect(html).toContain("tabular-nums");
    expect(html).toContain("Maya is drafting the recap");
    // The avatar gets its own reserved column, next to the label.
    expect(html).toContain("w-message");
  });

  it("cuts a long label with an ellipsis instead of widening the page", () => {
    const html = renderToString(
      <WorkingLine
        avatar={<span>avatar</span>}
        label={`Searching the web: ${"Club Med OR ".repeat(20)}`}
      />,
    );
    // The root must be allowed to shrink inside a flex row, or `truncate` never applies.
    expect(html).toMatch(/data-slot="working-line"[^>]*class="[^"]*min-w-0[^"]*max-w-full/);
    expect(html).toMatch(/class="[^"]*min-w-0 truncate[^"]*"/);
    expect(html).toMatch(
      /class="shrink-0 [^"]*"[^>]*data-slot="working-line-elapsed"|data-slot="working-line-elapsed"[^>]*class="shrink-0/,
    );
  });

  it("skips the avatar column entirely when there is no avatar", () => {
    const html = renderToString(<WorkingLine label="Reconnecting" />);
    expect(html).not.toContain("w-message");
  });

  it("keeps the ticking duration out of the announcement", () => {
    const html = renderToString(<WorkingLine avatar={null} label="working" startedAt={0} />);
    expect(html).toMatch(/aria-hidden="true"[^>]*data-slot="working-line-elapsed"/);
  });

  it("spreads the remaining props onto its root", () => {
    const html = renderToString(
      <WorkingLine avatar={null} label="working" data-testid="progress-message" />,
    );
    expect(html).toContain('data-testid="progress-message"');
  });

  it("drops the toggle again once the label fits, after it moved into the button", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    stubLayout({ scrollWidth: 500, clientWidth: 200 });
    const { container, root } = render(<WorkingLine label="A long label" />);
    expect(container.querySelector('[data-slot="working-line-toggle"]')).toBeTruthy();

    stubLayout({ scrollWidth: 200, clientWidth: 200 });
    act(() => resizeAll());

    expect(container.querySelector('[data-slot="working-line-toggle"]')).toBeNull();
    act(() => root.unmount());
  });
});
