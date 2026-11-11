// @vitest-environment jsdom

import type { MessageBlock } from "@tangow/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest doesn't run the lingui macro transform: same passthrough as the other web tests.
function identityTag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}
vi.mock("@lingui/core/macro", () => ({ t: identityTag }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: identityTag }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../../lib/rpc", () => ({ rpc: { onboarding: {} } }));

import { ChoiceCard } from "./message-cards";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ChoiceCard", () => {
  it("puts Dismiss in the end-aligned actions row and the options outside it", () => {
    const block = {
      kind: "choice",
      question: "What should we start with?",
      options: [
        { id: "a", letter: "A", label: "Inbox" },
        { id: "b", letter: "B", label: "Calendar" },
      ],
    } as Extract<MessageBlock, { kind: "choice" }>;
    act(() => {
      root.render(<ChoiceCard botId="bot-1" block={block} onBotChanged={async () => {}} />);
    });

    const row = container.querySelector('[data-slot="framed-block-actions"]');
    expect(row?.getAttribute("data-align")).toBe("end");
    expect([...(row?.querySelectorAll("button") ?? [])].map((el) => el.textContent)).toEqual([
      "Dismiss",
    ]);
    const options = container.querySelector('[data-testid="ask-options"]');
    expect([...(options?.querySelectorAll("button") ?? [])].map((el) => el.textContent)).toEqual([
      "A. Inbox",
      "B. Calendar",
    ]);
    expect(row?.contains(options ?? null)).toBe(false);
  });
});
