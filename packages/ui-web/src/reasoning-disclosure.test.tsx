import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReasoningDisclosure } from "./reasoning-disclosure.js";

const STEPS = [<span key="a">Read the calendar</span>, <span key="b">Drafted the recap</span>];

describe("ReasoningDisclosure", () => {
  it("folds the steps away behind a summary", () => {
    const html = renderToString(
      <ReasoningDisclosure summary="Thought for 41s · 2 steps" open={false} onToggle={() => {}}>
        {STEPS}
      </ReasoningDisclosure>,
    );

    expect(html).toContain('data-slot="reasoning-disclosure"');
    expect(html).toContain('data-slot="reasoning-disclosure-toggle"');
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("text-reasoning");
    expect(html).not.toContain("Read the calendar");
  });

  it("rails the steps behind a logical border once open", () => {
    const html = renderToString(
      <ReasoningDisclosure summary="Thought for 41s · 2 steps" open onToggle={() => {}}>
        {STEPS}
      </ReasoningDisclosure>,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-open="true"');
    expect(html).toContain("border-s-2");
    expect(html).toContain("ps-3");
    expect(html).toContain("rotate-90");
    expect(html).toContain("Read the calendar");
    expect(html).not.toContain("rk-shimmer");
  });

  it("shimmers only the last step while the run lives", () => {
    const html = renderToString(
      <ReasoningDisclosure summary="Thinking" open live onToggle={() => {}}>
        {STEPS}
      </ReasoningDisclosure>,
    );

    expect(html.match(/rk-shimmer/g)).toHaveLength(1);
    expect(html.indexOf("Read the calendar")).toBeLessThan(html.indexOf("rk-shimmer"));
  });

  it("wires the toggle to the panel it opens", () => {
    const closed = renderToString(
      <ReasoningDisclosure summary="Thought" open={false} onToggle={() => {}}>
        {STEPS}
      </ReasoningDisclosure>,
    );
    expect(closed).not.toContain("aria-controls");

    const open = renderToString(
      <ReasoningDisclosure summary="Thought" open onToggle={() => {}}>
        {STEPS}
      </ReasoningDisclosure>,
    );
    const controls = open.match(/aria-controls="([^"]+)"/);
    expect(controls).not.toBeNull();
    expect(open).toContain(`id="${controls?.[1]}"`);
  });

  it("spreads props onto the root and onto the toggle", () => {
    const html = renderToString(
      <ReasoningDisclosure
        summary="Thought"
        open={false}
        onToggle={() => {}}
        data-testid="agent-steps"
        toggleProps={{ "data-testid": "agent-steps-toggle" }}
      >
        {STEPS}
      </ReasoningDisclosure>,
    );

    expect(html).toContain('data-testid="agent-steps"');
    expect(html).toContain('data-testid="agent-steps-toggle"');
  });
});
