import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// vitest doesn't run the lingui macro/babel transform, so these macro imports must be
// mocked to a plain passthrough (same pattern as AskCard.test.tsx).
function identityTag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}
vi.mock("@lingui/core/macro", () => ({ t: identityTag }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: identityTag }),
  Trans: ({ children }: { children?: unknown }) => children,
}));

import { TaskCard } from "./TaskCard";

describe("TaskCard", () => {
  it("shows no status word for a finished task", () => {
    const html = renderToStaticMarkup(
      <TaskCard
        title="Status check"
        state="done"
        meta="Check the calendar"
        body="**ok**"
        onOpen={() => undefined}
      />,
    );

    expect(html).toContain("Status check");
    expect(html).toContain("border-outline");
    expect(html).not.toContain("Running");
    expect(html).not.toContain("Failed");
    expect(html).not.toContain("Cancelled");
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it("shows the running word, shimmered, under the title", () => {
    const html = renderToStaticMarkup(
      <TaskCard title="Status check" state="running" meta="Check the calendar" streaming />,
    );

    expect(html).toContain("Running");
    expect(html).toContain("rk-shimmer");
  });

  it("shows the failed word in the destructive colour", () => {
    const html = renderToStaticMarkup(
      <TaskCard title="Status check" state="failed" meta="Check the calendar" />,
    );

    expect(html).toContain("Failed");
    expect(html).toContain("text-destructive");
  });

  it("shows the cancelled word", () => {
    const html = renderToStaticMarkup(<TaskCard title="Status check" state="cancelled" />);

    expect(html).toContain("Cancelled");
  });

  it("is not interactive while it has no session to open", () => {
    const html = renderToStaticMarkup(
      <TaskCard title="Status check" state="running" meta="Check the calendar" body="Working" />,
    );

    expect(html).toContain("Check the calendar");
    expect(html).not.toContain("<button");
  });

  it("cuts a long result behind a fade and an expand badge", () => {
    const longBody = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const html = renderToStaticMarkup(
      <TaskCard title="Status check" state="done" body={longBody} />,
    );

    expect(html).toContain('data-capped="true"');
    expect(html).toContain("bg-linear-to-t");
  });

  it("names the status in the card's label and keeps result links out of its button", () => {
    const html = renderToStaticMarkup(
      <TaskCard
        title="Status check"
        state="failed"
        meta="Check the calendar"
        body="See [the doc](https://example.com)"
        onOpen={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Status check, Failed, Check the calendar"');
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*<a /s);
  });
});
