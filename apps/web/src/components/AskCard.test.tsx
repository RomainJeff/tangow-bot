// @vitest-environment jsdom

import { selectedAskActionLabel } from "@rakazo/core";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("AskCard editable Create bot card", () => {
  const spawnBot: NonNullable<AskBlock["spawnBot"]> = {
    name: "Veille",
    title: "Veille concurrentielle",
    instructions: "Watch competitors.\nCite the source.",
    prompt: "Start on the assigned work.",
    computerMode: "dedicated",
  };
  const pendingCard = (overrides: Partial<AskBlock> = {}): AskBlock => ({
    kind: "ask",
    text: "Create bot “Veille”?",
    approvalEffectId: "effect-1",
    detail: "Title: Veille concurrentielle\nInstructions:\n  Watch competitors.",
    status: "pending",
    actions: [
      { id: "allow", label: "Create bot", outcome: "created" },
      { id: "deny", label: "Cancel", outcome: "cancelled" },
    ],
    spawnBot,
    ...overrides,
  });

  let container: HTMLElement;
  let root: Root;
  const onAnswer = vi.fn<(text: string, edits?: unknown) => Promise<void>>();

  function show(
    block: AskBlock,
    options: { canAnswer?: boolean; messageId?: string; viewerUserId?: string } = {},
  ) {
    act(() => {
      root.render(
        <AskCard
          block={block}
          canAnswer={options.canAnswer ?? true}
          viewerUserId={options.viewerUserId}
          onAnswer={onAnswer}
          messageId={options.messageId ?? "msg-1"}
        />,
      );
    });
  }
  const labels = () => [...container.querySelectorAll("button")].map((el) => el.textContent);
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find((el) => el.textContent === label);
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  const nameInput = () => container.querySelector("input") as HTMLInputElement;
  const instructionsField = () => container.querySelector("textarea") as HTMLTextAreaElement;
  function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement : HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
    act(() => {
      setValue?.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function click(el: HTMLElement) {
    await act(async () => {
      el.click();
    });
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    onAnswer.mockReset();
    onAnswer.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("CA10: a pending card keeps its detail and puts Edit between Cancel and Create bot", () => {
    show(pendingCard());
    expect(labels()).toEqual(["Cancel", "Edit", "Create bot"]);
    expect(container.querySelector("pre")?.textContent).toContain("Instructions:");
    expect(container.querySelector("input")).toBeNull();
  });

  it("CA10: Edit unfolds prefilled fields and read-only rest, without duplicating instructions", () => {
    show(pendingCard());
    act(() => button("Edit").click());

    expect(container.textContent).toContain("Create bot?");
    expect(container.textContent).not.toContain("Create bot “Veille”?");
    expect(labels()).toEqual(["Cancel", "Create bot"]);
    expect(nameInput().value).toBe("Veille");
    expect(document.activeElement).toBe(nameInput());
    expect(instructionsField().value).toBe(spawnBot.instructions);
    expect(instructionsField().className).toContain("max-h-72");
    const readOnly = container.querySelector("pre")?.textContent ?? "";
    expect(readOnly).toContain("Title: Veille concurrentielle");
    expect(readOnly).toContain("Computer: Private");
    expect(readOnly).toContain("First message:\n  Start on the assigned work.");
    expect(readOnly).not.toContain("Instructions");
    expect(readOnly).not.toContain("Watch competitors");
  });

  it("CA10: Create bot without a change sends no edits", async () => {
    show(pendingCard());
    act(() => button("Edit").click());
    await click(button("Create bot"));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0]).toEqual(["allow"]);
  });

  it("CA10: Create bot sends only the fields that changed", async () => {
    show(pendingCard());
    act(() => button("Edit").click());
    type(nameInput(), "Veille EU");
    await click(button("Create bot"));
    expect(onAnswer.mock.calls[0]).toEqual(["allow", { name: "Veille EU" }]);

    onAnswer.mockClear();
    type(instructionsField(), "Watch European competitors.");
    await click(button("Create bot"));
    expect(onAnswer.mock.calls[0]).toEqual([
      "allow",
      { name: "Veille EU", instructions: "Watch European competitors." },
    ]);
  });

  it("CA10: an empty name disables Create bot, and Enter in the name does not submit", () => {
    show(pendingCard());
    act(() => button("Edit").click());
    act(() => {
      nameInput().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(onAnswer).not.toHaveBeenCalled();
    type(nameInput(), "   ");
    expect(button("Create bot").disabled).toBe(true);
  });

  it("CA10: a server error is announced and the fields keep what was typed", async () => {
    onAnswer.mockRejectedValueOnce(new Error("A bot named Comms already exists."));
    show(pendingCard());
    act(() => button("Edit").click());
    type(nameInput(), "Comms");
    await click(button("Create bot"));

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("A bot named Comms already exists.");
    expect(nameInput().value).toBe("Comms");
    expect(instructionsField().value).toBe(spawnBot.instructions);
    expect(button("Create bot").disabled).toBe(false);
  });

  it("CA10: an answered card is read-only, without Edit", () => {
    show(pendingCard({ status: "answered", answer: "allow" }));
    expect(labels()).toEqual([]);
    expect(container.textContent).toContain("Created");
    expect(container.querySelector("input")).toBeNull();
  });

  it("CA23: Cancel while editing leaves the edit, and the card's Cancel then refuses", async () => {
    show(pendingCard());
    act(() => button("Edit").click());
    type(nameInput(), "Veille EU");
    await click(button("Cancel"));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(container.querySelector("input")).toBeNull();
    expect(labels()).toEqual(["Create bot", "Edit", "Cancel"]);
    await click(button("Cancel"));
    expect(onAnswer.mock.calls).toEqual([["deny"]]);
  });

  it("offers Edit only to the run's owner", () => {
    const owned = pendingCard({ spawnBot: { ...spawnBot, ownerUserId: "user-1" } });
    show(owned, { viewerUserId: "user-1" });
    expect(labels()).toEqual(["Create bot", "Edit", "Cancel"]);
    show(owned, { viewerUserId: "user-2" });
    expect(labels()).toEqual(["Create bot", "Cancel"]);
  });

  it("CA23: the card becoming answered abandons the edit", () => {
    show(pendingCard());
    act(() => button("Edit").click());
    expect(container.querySelector("input")).not.toBeNull();
    show(pendingCard({ status: "answered", answer: "allow", spawnBot: { ...spawnBot } }));
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(labels()).toEqual([]);
  });

  it("CA23: showing another message abandons the edit", () => {
    show(pendingCard(), { messageId: "msg-1" });
    act(() => button("Edit").click());
    type(nameInput(), "Draft");
    show(pendingCard(), { messageId: "msg-2" });
    expect(container.querySelector("input")).toBeNull();
    expect(labels()).toEqual(["Cancel", "Edit", "Create bot"]);
  });

  it("CA24: no Edit without spawnBot, when unanswerable, or on another approval", () => {
    show(pendingCard({ spawnBot: undefined }));
    expect(labels()).toEqual(["Cancel", "Create bot"]);
    show(pendingCard(), { canAnswer: false });
    expect(labels()).toEqual([]);
    show(
      pendingCard({
        spawnBot: undefined,
        text: "Send the email?",
        actions: [
          { id: "allow", label: "Allow once" },
          { id: "deny", label: "Deny" },
        ],
      }),
    );
    expect(labels()).toEqual(["Deny", "Allow once"]);
  });
});

describe("AskCard action layout", () => {
  const render = (block: AskBlock) =>
    renderToStaticMarkup(
      <AskCard block={block} canAnswer={true} onAnswer={async () => {}} messageId="msg-layout" />,
    );
  /** The framed block's action row: its alignment and its button labels, left to right. */
  const actionsRow = (html: string) => {
    const start = html.indexOf('data-slot="framed-block-actions"');
    if (start < 0) return null;
    const row = html.slice(start);
    return {
      align: /data-align="(\w+)"/.exec(row)?.[1],
      labels: [...row.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) =>
        match[1]?.replace(/<svg.*?<\/svg>/g, ""),
      ),
    };
  };
  const optionsRow = (html: string) => {
    const start = html.indexOf('data-testid="ask-options"');
    return html.slice(start, html.indexOf("</div>", start));
  };

  it("keeps an approval's decision on the right, primary last", () => {
    const html = render({
      kind: "ask",
      text: "Send the email?",
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(actionsRow(html)).toEqual({
      align: "end",
      labels: ["Deny", "Always allow this tool", "Allow once"],
    });
  });

  it("keeps a secret's single action on the right", () => {
    const html = render({
      kind: "ask",
      text: "Paste the key",
      purpose: "api_key",
      input: "secret",
    });
    expect(actionsRow(html)).toEqual({ align: "end", labels: ["Save"] });
  });

  it("keeps the answers of a choice on the left, not the decision to type another", () => {
    const html = render({
      kind: "ask",
      text: "Which city?",
      actions: [
        { id: "seoul", label: "Seoul" },
        { id: "tokyo", label: "Tokyo" },
      ],
    });
    expect(optionsRow(html)).toContain("Seoul");
    expect(optionsRow(html)).not.toContain("justify-end");
    expect(actionsRow(html)).toEqual({ align: "start", labels: ["Other answer…"] });
  });

  it("puts a plain question's decision on the right, Edit first before Send it", () => {
    const html = render({ kind: "ask", text: "Send this draft?" });
    expect(actionsRow(html)).toEqual({ align: "end", labels: ["Edit first", "Send it"] });
  });

  it("puts a stepper's navigation before its primary, on the right", () => {
    const html = renderToStaticMarkup(
      <AskCard
        block={{
          kind: "ask",
          text: "Two questions",
          questions: [
            { id: "q1", question: "Where?", options: [{ id: "a", label: "Seoul" }] },
            { id: "q2", question: "When?", required: false, options: [{ id: "b", label: "May" }] },
          ],
        }}
        canAnswer={true}
        onAnswer={async () => {}}
        messageId="msg-stepper"
      />,
    );
    expect(actionsRow(html)).toEqual({ align: "end", labels: ["Next"] });
    expect(optionsRow(html)).toContain("Seoul");
    expect(optionsRow(html)).not.toContain("justify-end");
  });
});
