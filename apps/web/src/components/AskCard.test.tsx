import { selectedAskActionLabel } from "@rakazo/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// vitest doesn't run the lingui macro/babel transform, so these macro imports must be
// mocked to a plain passthrough (same pattern as KnowledgeSection.test.tsx).
function identityTag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}
vi.mock("@lingui/core/macro", () => ({ t: identityTag }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: identityTag }),
  Trans: ({ children }: { children?: unknown }) => children,
}));

import { type AskBlock, AskCard } from "./AskCard";

describe("selectedAskActionLabel", () => {
  it("maps a choice answer id to its user-facing label", () => {
    expect(
      selectedAskActionLabel("choice-2", [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul" },
      ]),
    ).toBe("Seoul");
  });

  it("falls back to the answer when an action is unavailable", () => {
    expect(selectedAskActionLabel("custom", undefined)).toBe("custom");
  });
});

describe("AskCard multi-question answered rendering", () => {
  const questions: NonNullable<AskBlock["questions"]> = [
    {
      id: "q1",
      question: "Which city should I use?",
      options: [{ id: "berlin", label: "Berlin" }],
    },
    { id: "q2", question: "Any dietary restriction?" },
  ];

  it("resolved via the composer (no block.answers): compact trace, no fabricated per-question value", () => {
    const block: AskBlock = {
      kind: "ask",
      text: "",
      status: "answered",
      answer: "Berlin, no restrictions",
      questions,
    };

    const html = renderToStaticMarkup(
      <AskCard block={block} canAnswer={true} onAnswer={async () => {}} messageId="msg-composer" />,
    );

    // Questions stay as a resolved trace of what was asked.
    expect(html).toContain("Which city should I use?");
    expect(html).toContain("Any dietary restriction?");
    // No per-question "Answered" is repeated, and the free-text answer isn't duplicated
    // into the card (it lives in the user's message bubble instead).
    expect(html).not.toContain("Answered");
    expect(html).not.toContain("Berlin, no restrictions");
    // Settled: the progress dots have nothing left to track.
    expect(html).not.toContain("bg-success");
    expect(html).not.toContain("bg-muted-foreground/40");
  });

  it("resolved via the card (block.answers present): structured breakdown is unchanged", () => {
    const block: AskBlock = {
      kind: "ask",
      text: "",
      status: "answered",
      answer: "",
      questions,
      answers: {
        q1: { selected: ["berlin"] },
        q2: { other: "vegetarian" },
      },
    };

    const html = renderToStaticMarkup(
      <AskCard block={block} canAnswer={true} onAnswer={async () => {}} messageId="msg-card" />,
    );

    expect(html).toContain("Berlin");
    expect(html).toContain("Other: vegetarian");
  });

  it("a single settled question shows its answer under the question, once", () => {
    const block: AskBlock = {
      kind: "ask",
      text: "",
      status: "answered",
      answer: "",
      questions: [questions[0]!],
      answers: { q1: { selected: ["berlin"] } },
    };

    const html = renderToStaticMarkup(
      <AskCard block={block} canAnswer={true} onAnswer={async () => {}} messageId="msg-single" />,
    );

    expect(html.split("Which city should I use?").length - 1).toBe(1);
    expect(html).not.toContain("1. ");
    expect(html).toContain("Berlin");
  });
});

describe("AskCard mono-question answered rendering", () => {
  it("resolved via the composer (no block.answer): plain resolved state, reply not echoed onto the card", () => {
    // The backend marks the card answered without an `answer` payload (design D2 — the reply
    // lives in the user's message bubble), so the card must not reprint it.
    const block: AskBlock = {
      kind: "ask",
      text: "Which city should I use?",
      status: "answered",
      input: "text",
    };

    const html = renderToStaticMarkup(
      <AskCard block={block} canAnswer={true} onAnswer={async () => {}} messageId="msg-composer" />,
    );

    // The question stays as a trace; the resolved state reads "Answered" with no echoed value.
    expect(html).toContain("Which city should I use?");
    expect(html).toContain("Answered");
    expect(html).not.toContain("Answered:");
  });

  it("resolved via the card (block.answer present): the chosen label is still shown", () => {
    const block: AskBlock = {
      kind: "ask",
      text: "Which city should I use?",
      status: "answered",
      answer: "choice-2",
      actions: [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul" },
      ],
    };

    const html = renderToStaticMarkup(
      <AskCard block={block} canAnswer={true} onAnswer={async () => {}} messageId="msg-card" />,
    );

    expect(html).toContain("Answered: Seoul");
  });
});

describe("AskCard approval actions", () => {
  const approvalBlock = (
    text: string,
    actions: NonNullable<AskBlock["actions"]>,
    detail?: string,
  ): AskBlock => ({
    kind: "ask",
    text,
    approvalEffectId: "effect-1",
    ...(detail ? { detail } : {}),
    actions,
  });
  const render = (block: AskBlock) =>
    renderToStaticMarkup(
      <AskCard block={block} canAnswer={true} onAnswer={async () => {}} messageId="msg-approval" />,
    );

  it("labels a spawn_bot card Create bot / Cancel, not Create space", () => {
    const html = render(
      approvalBlock(
        "Create bot “Veille”?",
        [
          { id: "allow", label: "Create bot", outcome: "created" },
          { id: "deny", label: "Cancel", outcome: "cancelled" },
        ],
        "Title: Veille\nInstructions:\n  Watch competitors",
      ),
    );

    expect(html).toContain("Create bot");
    expect(html).not.toContain("Create space");
    expect(html).toContain("Cancel");
    expect(html).toContain("Instructions:");
  });

  it("keeps Create space on a create_space card", () => {
    const html = render(
      approvalBlock("Create space “Ops”?", [
        { id: "allow", label: "Create space", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ]),
    );

    expect(html).toContain("Create space");
    expect(html).not.toContain("Create bot");
  });

  it("keeps the generic labels on a card without an outcome", () => {
    const html = render(
      approvalBlock("Send the email?", [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow" },
        { id: "deny", label: "Deny" },
      ]),
    );

    expect(html).toContain("Allow once");
    expect(html).toContain("Always allow this tool");
    expect(html).toContain("Deny");
  });

  const spawnActions: NonNullable<AskBlock["actions"]> = [
    { id: "allow", label: "Create bot", outcome: "created" },
    { id: "deny", label: "Cancel", outcome: "cancelled" },
  ];

  it("drops an image in an approval question, but not in a plain ask", () => {
    const image = "![](https://e.example/p.png)";
    expect(render(approvalBlock(`Create bot “${image}”?`, spawnActions))).not.toContain("<img");

    const plain = render({ kind: "ask", text: `Is this right? ${image}` });
    expect(plain).toContain("<img");
  });
});
