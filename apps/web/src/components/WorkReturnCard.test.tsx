import type { WorkReturn } from "@rakazo/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkReturnCard } from "./WorkReturnCard";

// The node test run has no Lingui vite transform; substitute the runtime tag with a plain
// interpolation. The guarantee under test is which label each outcome shows.
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
}));
// The card can unfold a task tree, whose module loads the react macro too.
vi.mock("@lingui/react/macro", () => ({
  Plural: () => null,
  Trans: ({ children }: { children?: unknown }) => children,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));

function render(outcome: WorkReturn["outcome"]) {
  return renderToStaticMarkup(
    <WorkReturnCard
      workReturn={{ workId: "work-1", executorBotId: "bot-specialist", outcome }}
      specialistName="Researcher"
    />,
  );
}

describe("WorkReturnCard", () => {
  it("offers no task link outside a thread that holds its tasks", () => {
    const html = renderToStaticMarkup(
      <WorkReturnCard
        workReturn={{ workId: "work-1", executorBotId: "bot-specialist", outcome: "result" }}
        specialistName="Researcher"
        cardKey="return:message-1:0"
      />,
    );
    expect(html).not.toContain("task-tree-disclosure");
  });

  it("shows the specialist without internal work-return identifiers", () => {
    const html = render("result");
    expect(html).toContain("Researcher");
    expect(html).toContain("text-foreground");
    expect(html).not.toContain("purpose");
    expect(html).not.toContain("work_return");
    expect(html).not.toContain("work-1");
    expect(html).not.toContain("root-work-1");
    expect(html).not.toContain(">outcome<");
    expect(html).not.toContain("executorBotId");
    expect(html).not.toContain("bot-specialist");
  });

  it("marks a failed return as destructive, without a success check or class", () => {
    const html = render("failed");
    expect(html).toContain("text-destructive");
    expect(html).not.toContain("✓");
    expect(html).not.toContain("text-success");
  });

  it("marks a successful return with the existing success check", () => {
    const html = render("result");
    expect(html).toContain("✓");
    expect(html).toContain("text-success");
    expect(html).not.toContain("text-destructive");
  });

  it.each(["cancelled", "no_result"] as const)(
    "marks a %s return with a neutral glyph, neither a success nor a failure",
    (outcome) => {
      const html = render(outcome);
      expect(html).toContain("text-muted-foreground");
      expect(html).not.toContain("✓");
      expect(html).not.toContain("text-success");
      expect(html).not.toContain("text-destructive");
    },
  );

  it.each([
    ["result", "Done"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
    ["no_result", "No result"],
  ] as const)("names a %s return with its short label", (outcome, label) => {
    expect(render(outcome)).toContain(`>${label}<`);
  });

  it("marks an unknown return without any outcome check", () => {
    const html = render("unknown");
    expect(html).not.toContain("✓");
    expect(html).not.toContain("text-success");
    expect(html).not.toContain("text-destructive");
  });
});
