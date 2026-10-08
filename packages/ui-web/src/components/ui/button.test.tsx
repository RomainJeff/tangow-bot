import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button.js";

describe("Button — Quiet variants", () => {
  it("renders the primary capsule on ink", () => {
    const html = renderToString(
      <Button variant="capsule" size="capsule">
        Allow once
      </Button>,
    );

    expect(html).toContain('data-slot="button"');
    expect(html).toContain('type="button"');
    expect(html).toContain("rounded-full");
    expect(html).toContain("bg-primary");
    expect(html).toContain("text-primary-foreground");
    expect(html).toContain("text-capsule");
    expect(html).toContain("h-capsule");
    expect(html).not.toContain("text-sm");
  });

  it("renders the secondary, tertiary and quick-reply capsules", () => {
    expect(
      renderToString(
        <Button variant="capsuleSecondary" size="capsule">
          Deny
        </Button>,
      ),
    ).toContain("bg-secondary");
    expect(
      renderToString(
        <Button variant="tertiary" size="capsule">
          Skip
        </Button>,
      ),
    ).toContain("text-muted-foreground");
    const quickReply = renderToString(
      <Button variant="quickReply" size="quickReply">
        Tuesday
      </Button>,
    );
    expect(quickReply).toContain("border-outline");
    expect(quickReply).toContain("h-quick-reply");
  });

  it("shows a tertiary button that holds something open as pressed", () => {
    const html = renderToString(
      <Button variant="tertiary" size="capsule" aria-pressed={true}>
        Computer
      </Button>,
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("aria-pressed:bg-accent");
    expect(html).toContain("aria-pressed:text-foreground");
  });

  it("sizes the round icon buttons from the size tokens", () => {
    expect(
      renderToString(<Button variant="roundIcon" size="roundIcon" aria-label="Send" />),
    ).toContain("size-composer-icon");
    expect(
      renderToString(<Button variant="roundIcon" size="roundIconSm" aria-label="Reply" />),
    ).toContain("size-hover-icon");
    expect(
      renderToString(
        <Button variant="capsule" size="stack">
          Allow once
        </Button>,
      ),
    ).toContain("h-mobile-stack");
    expect(
      renderToString(<Button variant="capsule" size="call" aria-label="End call" />),
    ).toContain("size-call-button");
  });

  it("fills the secondary round icon button instead of leaving it transparent", () => {
    const html = renderToString(
      <Button variant="roundIconSecondary" size="roundIconSm" aria-label="New routine" />,
    );
    expect(html).toContain("bg-secondary");
    expect(html).not.toContain("bg-transparent");
  });

  it("locks a consequential action before it is pressed", () => {
    const html = renderToString(
      <Button consequential variant="capsule" size="capsule">
        Always allow this tool
      </Button>,
    );

    expect(html).toContain('data-consequential="true"');
    expect(html).toContain("<svg");
    expect(html).toContain("size-3.25");
  });

  it("keeps a plain button free of the lock", () => {
    const html = renderToString(
      <Button variant="capsule" size="capsule">
        Allow once
      </Button>,
    );
    expect(html).not.toContain("data-consequential");
    expect(html).not.toContain("<svg");
  });

  it("settles a capsule at 0.96 and a round control at 0.94", () => {
    for (const size of ["capsule", "quickReply", "stack"] as const) {
      const html = renderToString(
        <Button variant="capsule" size={size}>
          Allow once
        </Button>,
      );
      expect(html, size).toContain("rk-press ");
      expect(html, size).not.toContain("rk-press-round");
    }
    for (const size of ["roundIcon", "roundIconSm", "call"] as const) {
      const html = renderToString(<Button variant="roundIcon" size={size} aria-label="Reply" />);
      expect(html, size).toContain("rk-press-round");
    }
  });

  it("leaves the stock variants untouched", () => {
    const html = renderToString(<Button>Save</Button>);
    expect(html).toContain("rounded-lg");
    expect(html).toContain("bg-primary");
    expect(html).toContain("h-8");
    expect(html).toContain("text-sm");
  });
});
