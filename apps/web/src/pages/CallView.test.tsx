import type { MessageBlock } from "@tangow/contracts";
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
vi.mock("../lib/dictation", () => ({
  dictation: { listen: vi.fn(), stop: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));
vi.mock("../lib/tts", () => ({
  speaker: { speak: vi.fn(), stop: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));
vi.mock("../lib/desktop", () => ({ desktopBridge: () => null }));

import { CallView } from "./CallView";

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

function renderCall(block: AskBlock): string {
  return renderToStaticMarkup(
    <CallView
      botId="bot-1"
      botName="Claudius"
      botColor="#000000"
      transcribe={false}
      thread={{
        messages: [],
        running: false,
        ask: { block, target: { thread: { botId: "bot-1" }, runId: "run-1", messageId: "msg-1" } },
      }}
      onSend={async () => {}}
      onFollowUp={async () => {}}
      onAnswer={async () => {}}
      onClose={() => {}}
    />,
  );
}

const spawnActions: NonNullable<AskBlock["actions"]> = [
  { id: "allow", label: "Create bot", outcome: "created" },
  { id: "deny", label: "Cancel", outcome: "cancelled" },
];

describe("CallView approval actions", () => {
  it("offers only Cancel on a Create bot card", () => {
    const html = renderCall({
      kind: "ask",
      text: "Create bot “Veille”?",
      approvalEffectId: "effect-1",
      detail: "Title: Veille",
      actions: spawnActions,
      spawnBot: {
        name: "Veille",
        title: "Veille",
        instructions: "Track them.",
        prompt: "",
        computerMode: "",
      },
    });

    expect(html).toContain("Cancel");
    expect(html).not.toContain("Create bot");
  });

  it("keeps both actions, correctly labelled, on an approval that is not a Create bot card", () => {
    const html = renderCall({
      kind: "ask",
      text: "Create bot “Veille”?",
      approvalEffectId: "effect-1",
      actions: spawnActions,
    });

    expect(html).toContain("Create bot");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("Create space");
  });
});
