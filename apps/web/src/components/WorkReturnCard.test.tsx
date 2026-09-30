import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkReturn } from "../lib/work-return";
import { WorkReturnCard } from "./WorkReturnCard";

function render(outcome: WorkReturn["outcome"]) {
  return renderToStaticMarkup(
    <WorkReturnCard
      workReturn={{ workId: "work-1", executorBotId: "bot-specialist", outcome }}
      specialistName="Researcher"
    />,
  );
}

describe("WorkReturnCard", () => {
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

  it("marks an unknown return without any outcome check", () => {
    const html = render("unknown");
    expect(html).not.toContain("✓");
    expect(html).not.toContain("text-success");
    expect(html).not.toContain("text-destructive");
  });
});
