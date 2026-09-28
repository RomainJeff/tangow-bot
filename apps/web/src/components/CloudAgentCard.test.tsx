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

import type { MessageBlock } from "@rakazo/contracts";
import { CloudAgentCard } from "./CloudAgentCard";

function block(
  overrides: Partial<Extract<MessageBlock, { kind: "cloud_agent" }>>,
): Extract<MessageBlock, { kind: "cloud_agent" }> {
  return {
    kind: "cloud_agent",
    title: "Add a README",
    status: "running",
    ...overrides,
  } as Extract<MessageBlock, { kind: "cloud_agent" }>;
}

describe("CloudAgentCard", () => {
  it("shows no status word once finished — 'Pull request' is the only meta line (A8b)", () => {
    const html = renderToStaticMarkup(
      <CloudAgentCard
        block={block({ status: "finished", prUrl: "https://github.com/example/demo/pull/1" })}
      />,
    );

    expect(html).toContain("Pull request");
    expect(html).not.toContain("running");
    expect(html).not.toContain("failed");
    expect(html).not.toContain("cancelled");
    expect(html).toContain("border-outline");
  });

  it("opens the pull request in a new tab — the whole card is the link", () => {
    const html = renderToStaticMarkup(
      <CloudAgentCard
        block={block({ status: "finished", prUrl: "https://github.com/example/demo/pull/1" })}
      />,
    );

    expect(html).toContain('href="https://github.com/example/demo/pull/1"');
    expect(html).toContain('target="_blank"');
    // The testid sits on the card inside the link, so a click anywhere inside
    // the link's bounding box opens it (matches the e2e's `card.locator("..")`).
    expect(html.indexOf('data-testid="cloud-agent-card"')).toBeGreaterThan(html.indexOf("<a "));
  });

  it("shows the running word while still going — same status rule as TaskCard", () => {
    const html = renderToStaticMarkup(<CloudAgentCard block={block({ status: "running" })} />);
    expect(html).toContain("Running");
    expect(html).toContain("rk-shimmer");
  });

  it("falls back to the branch when there is no pull request yet", () => {
    const html = renderToStaticMarkup(
      <CloudAgentCard block={block({ status: "running", branch: "add-readme" })} />,
    );
    expect(html).toContain("add-readme");
    expect(html).not.toContain("Pull request");
  });
});
