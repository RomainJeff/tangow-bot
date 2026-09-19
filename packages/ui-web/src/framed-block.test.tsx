import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FramedBlock } from "./framed-block.js";

describe("FramedBlock", () => {
  it("frames the question on the one elevated surface", () => {
    const html = renderToString(
      <FramedBlock
        header={{ who: "Maya needs your call", dot: true }}
        question="Send the recap to #ops?"
        consequence="They will see the last 12 messages."
        actions={<button type="button">Send</button>}
      />,
    );

    expect(html).toContain('data-slot="framed-block"');
    expect(html).toContain("rounded-block");
    expect(html).toContain("bg-surface");
    expect(html).toContain("shadow-card");
    expect(html).toContain("text-block-header");
    expect(html).toContain("text-question");
    expect(html).toContain('data-slot="framed-block-consequence"');
    expect(html).toContain('data-slot="framed-block-actions"');
    expect(html).not.toContain('data-answered="true"');
  });

  it("renders no header row when the row above already names who is asking", () => {
    const html = renderToString(
      <FramedBlock question="Which room?" actions={<button type="button">Send</button>} />,
    );
    expect(html).not.toContain('data-slot="framed-block-header"');
    expect(html).not.toContain("text-block-header");
    expect(html).toContain('data-slot="framed-block-question"');
  });

  it("hides the ink dot unless the block is waiting on someone", () => {
    const html = renderToString(
      <FramedBlock header={{ who: "Maya asked" }} question="Which room?" />,
    );
    expect(html).not.toContain("bg-foreground");
    expect(html).not.toContain('data-slot="framed-block-actions"');
  });

  it("settles once answered: no controls, no actions, just the answer", () => {
    const html = renderToString(
      <FramedBlock
        header={{ who: "Maya needs your call" }}
        question="Send the recap to #ops?"
        actions={<button type="button">Send</button>}
        answered="Answered: sent to #ops"
      >
        <input aria-label="Other room" />
      </FramedBlock>,
    );

    expect(html).toContain('data-answered="true"');
    expect(html).toContain('data-slot="framed-block-answered"');
    expect(html).toContain("text-meta");
    expect(html).not.toContain('data-slot="framed-block-actions"');
    expect(html).not.toContain('data-slot="framed-block-body"');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });

  it("passes a className and the remaining props through", () => {
    const html = renderToString(
      <FramedBlock
        className="max-w-thread"
        data-testid="secret-ask-card"
        header={{ who: "Maya" }}
        question="Now?"
      />,
    );
    expect(html).toContain("max-w-thread");
    expect(html).toContain('data-testid="secret-ask-card"');
  });
});
