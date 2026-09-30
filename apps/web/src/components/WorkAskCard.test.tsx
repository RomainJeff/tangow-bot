import { i18n } from "@lingui/core";
import type { PendingWorkAsk, ThreadMessage } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkAskCard } from "./WorkAskCard";

// The node test run has no Lingui vite transform, so the macro imports inside AskCard
// cannot load; substitute the runtime tag with a plain interpolation. The guarantee under
// test is the card's composition, not the catalog machinery.
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings
      .map((part, index) => (index === 0 ? part : `${values[index - 1] ?? ""}${part}`))
      .join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings
        .map((part, index) => (index === 0 ? part : `${values[index - 1] ?? ""}${part}`))
        .join(""),
  }),
}));

i18n.activate("en");

const askBlock = {
  kind: "ask" as const,
  approvalEffectId: "effect-1",
  text: "Review before computer_act",
  status: "pending" as const,
  actions: [
    { id: "allow", label: "Allow once" },
    { id: "always", label: "Always allow this tool" },
    { id: "deny", label: "Deny" },
  ],
};

const message = {
  id: "ask-message-1",
  threadId: "thread-work",
  seq: 3,
  role: "bot" as const,
  blocks: [askBlock],
  createdAt: "2026-09-24T08:00:00.000Z",
};

const pendingWork: PendingWorkAsk = {
  workId: "work-1",
  rootWorkId: "work-1",
  depth: 0,
  coordinator: { botId: "bot-coordinator", name: "Chief" },
  specialist: { botId: "bot-specialist", name: "Researcher" },
  runId: "run-specialist",
  message,
};

function render(
  overrides: Partial<{ error: string | null; blocks: ThreadMessage["blocks"] }> = {},
) {
  const work: PendingWorkAsk = {
    ...pendingWork,
    message: { ...message, blocks: overrides.blocks ?? message.blocks },
  };
  return renderToStaticMarkup(
    <WorkAskCard
      pendingWork={work}
      error={overrides.error ?? null}
      onAnswer={async () => undefined}
    />,
  );
}

describe("WorkAskCard", () => {
  it("names the specialist and the coordinator that delegated the work", () => {
    const html = render();
    expect(html).toContain("Researcher");
    expect(html).toContain("Chief");
    expect(html).toContain("delegated by");
  });

  it("offers the original ask's actions, always included", () => {
    const html = render();
    expect(html).toContain("Allow once");
    expect(html).toContain("Always allow this tool");
    expect(html).toContain("Deny");
  });

  it("shows a settle failure without disguising it as a success", () => {
    const html = render({ error: "This prompt is no longer awaiting an answer" });
    expect(html).toContain("This prompt is no longer awaiting an answer");
    // The failure stays visible while the ask itself is still pending.
    expect(html).toContain("Allow once");
  });

  it("renders nothing when the message carries no ask block", () => {
    const html = render({ blocks: [{ kind: "text", text: "no ask here" }] });
    expect(html).not.toContain("delegated by");
    expect(html).not.toContain("Allow once");
  });
});
