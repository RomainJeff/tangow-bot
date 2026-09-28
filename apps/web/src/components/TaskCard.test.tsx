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
      <TaskCard title="Status check" state="done" meta="Check the calendar" body="**ok**" />,
    );

    expect(html).toContain("Status check");
    expect(html).toContain("border-outline");
    expect(html).not.toContain("Running");
    expect(html).not.toContain("Failed");
    expect(html).not.toContain("Cancelled");
    // Whole card opens the brief and the result whole.
    expect(html).toContain("<button");
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

  it("is not interactive when it carries neither a brief nor a result", () => {
    const html = renderToStaticMarkup(<TaskCard title="Status check" state="done" />);

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
});
