// @vitest-environment jsdom

import { routineConfirmationBlock, settleRoutineAsk } from "@rakazo/core";
import { act, useLayoutEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
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

const cities: AskBlock = {
  kind: "ask",
  text: "Which city should I use?",
  actions: [
    { id: "choice-1", label: "Berlin" },
    { id: "choice-2", label: "Seoul" },
  ],
};

describe("AskCard settled question (CA3)", () => {
  const questions: NonNullable<AskBlock["questions"]> = [
    {
      id: "q1",
      question: "Which city should I use?",
      options: [{ id: "berlin", label: "Berlin" }],
    },
    { id: "q2", question: "Any dietary restriction?" },
  ];
  const render = (block: AskBlock) =>
    renderToStaticMarkup(
      <AskCard block={block} canAnswer={false} onAnswer={async () => {}} messageId="msg-settled" />,
    );

  it("answered from the composer: the questions as one line, no answer bubble", () => {
    const html = render({
      kind: "ask",
      text: "",
      status: "answered",
      answer: "Berlin, no restrictions",
      questions,
    });
    expect(html).toContain("Which city should I use? · Any dietary restriction?");
    expect(html).not.toContain("Your answer");
    expect(html).not.toContain("Berlin, no restrictions");
  });

  it("answered on the card: one line per question in the answer bubble", () => {
    const html = render({
      kind: "ask",
      text: "",
      status: "answered",
      questions,
      answers: { q1: { selected: ["berlin"] }, q2: { other: "vegetarian" } },
    });
    expect(html).toContain(
      'aria-label="Your answer: Which city should I use? — Berlin; Any dietary restriction? — vegetarian"',
    );
  });

  it("a legacy choice: the question once, and the chosen label as the user's answer", () => {
    const html = render({ ...cities, status: "answered", answer: "choice-2" });
    expect(html.split("Which city should I use?").length - 1).toBe(1);
    expect(html).toContain('aria-label="Your answer: Seoul"');
    expect(html).not.toContain("<button");
  });

  it("an answered secret or approval keeps its own state line, with no answer bubble (TM CA22)", () => {
    const text = (block: AskBlock) => render(block).replace(/<[^>]+>/g, "");
    expect({
      secret: text({
        kind: "ask",
        text: "API key?",
        input: "secret",
        status: "answered",
        answer: "",
      }),
      approval: text({
        kind: "ask",
        text: "Send?",
        approvalEffectId: "e1",
        status: "answered",
        answer: "allow",
        actions: [
          { id: "allow", label: "Allow" },
          { id: "deny", label: "Deny" },
        ],
      }),
    }).toEqual({ secret: "API key?Saved", approval: "Needs your callSend?Allowed once" });
  });

  it("lists two answers that read the same as two lines", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const container = document.createElement("div");
    const root = createRoot(container);
    const day = (id: string) => ({
      id,
      header: "Day",
      question: "Which day?",
      options: [{ id: `${id}-monday`, label: "Monday" }],
    });
    act(() => {
      root.render(
        <AskCard
          block={{
            kind: "ask",
            text: "",
            status: "answered",
            questions: [day("q1"), day("q2")],
            answers: { q1: { selected: ["q1-monday"] }, q2: { selected: ["q2-monday"] } },
          }}
          canAnswer={false}
          onAnswer={async () => {}}
          messageId="msg-same-lines"
        />,
      );
    });
    const bubble = container.querySelector('[aria-label^="Your answer"]');
    const shown = {
      lines: [...(bubble?.children ?? [])].map((line) => line.textContent),
      keyWarnings: errors.mock.calls.filter(([message]) => String(message).includes("same key")),
    };
    act(() => root.unmount());
    errors.mockRestore();
    vi.unstubAllGlobals();
    expect(shown).toEqual({ lines: ["Day — Monday", "Day — Monday"], keyWarnings: [] });
  });

  it("no longer waiting: the question and No longer active, nothing to press", () => {
    const html = render(cities);
    expect(html).toContain("No longer active");
    expect(html).not.toContain("<button");
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

  it("never fetches an image in a question, an approval's or a plain one (CA16)", () => {
    const image = "![](https://e.example/p.png)";
    const shown = (html: string) => ({
      images: html.includes("<img"),
      text: /<p[^>]*>(.*?)<\/p>/.exec(html)?.[1],
    });
    expect({
      approval: shown(render(approvalBlock(`Create bot “${image}”?`, spawnActions))),
      plain: shown(render({ kind: "ask", text: `Is this right? ${image}` })),
    }).toEqual({
      approval: { images: false, text: "Create bot “”?" },
      plain: { images: false, text: "Is this right? " },
    });
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
    expect(labels()).toEqual(["Cancel", "Edit", "Create bot"]);
    await click(button("Cancel"));
    expect(onAnswer.mock.calls).toEqual([["deny"]]);
  });

  it("offers Edit only to the run's owner", () => {
    const owned = pendingCard({ spawnBot: { ...spawnBot, ownerUserId: "user-1" } });
    show(owned, { viewerUserId: "user-1" });
    expect(labels()).toEqual(["Cancel", "Edit", "Create bot"]);
    show(owned, { viewerUserId: "user-2" });
    expect(labels()).toEqual(["Cancel", "Create bot"]);
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
  const actionsHtml = (html: string) =>
    html.slice(html.indexOf('data-slot="framed-block-actions"'));

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

  it("lists a choice's answers as tiles, Other… last, with no action row", () => {
    const html = render(cities);
    expect(actionsRow(html)).toBeNull();
    expect(
      [...html.matchAll(/data-slot="option-tile"[^>]*>(.*?)<\/button>/g)].map((match) =>
        match[1]?.replace(/<[^>]+>/g, ""),
      ),
    ).toEqual(["Berlin", "Seoul", "Other…"]);
  });

  it("puts an optional question's Skip on the right", () => {
    const html = render({
      kind: "ask",
      text: "",
      questions: [
        { id: "q1", question: "When?", required: false, options: [{ id: "b", label: "May" }] },
      ],
    });
    expect(actionsRow(html)).toEqual({ align: "end", labels: ["Skip"] });
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
    expect(actionsHtml(html)).not.toContain("Seoul");
  });
});

describe("AskCard stepper navigation", () => {
  let container: HTMLElement;
  let root: Root;

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

  it("orders Back, Skip, Send answers in the end-aligned row on an optional last step", () => {
    act(() => {
      root.render(
        <AskCard
          block={{
            kind: "ask",
            text: "Two questions",
            questions: [
              { id: "q1", question: "Where?", options: [{ id: "a", label: "Seoul" }] },
              {
                id: "q2",
                question: "When?",
                required: false,
                options: [{ id: "b", label: "May" }],
              },
            ],
          }}
          canAnswer={true}
          onAnswer={async () => {}}
          messageId="msg-stepper-client"
        />,
      );
    });
    const next = [...container.querySelectorAll("button")].find((el) => el.textContent === "Next");
    act(() => next?.click());

    const row = container.querySelector('[data-slot="framed-block-actions"]');
    expect(row?.getAttribute("data-align")).toBe("end");
    expect([...(row?.querySelectorAll("button") ?? [])].map((el) => el.textContent)).toEqual([
      "Back",
      "Skip",
      "Send answers",
    ]);
    expect(row?.textContent).not.toContain("May");
    expect(container.textContent).toContain("When?");
  });
});

describe("AskCard open question", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // jsdom has no Web Animations, so these run the reduced-motion commit; e2e flies the tile.
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  let messages = 0;
  function mount(block: AskBlock, onAnswer: (text: string) => Promise<void>) {
    const messageId = `msg-open-${++messages}`;
    act(() => {
      root.render(
        <AskCard block={block} canAnswer={true} onAnswer={onAnswer} messageId={messageId} />,
      );
    });
  }
  const tile = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('[data-slot="option-tile"]')].find(
      (button) => button.textContent === name,
    );
  const press = (target: Element, key: string) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  const type = (input: HTMLInputElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  it("holds a tapped option 650 ms, then shows it as the user's answer", async () => {
    const sent: string[] = [];
    mount(cities, async (text) => void sent.push(text));
    act(() => tile("Seoul")?.click());
    expect(tile("Seoul")?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => vi.advanceTimersByTime(649));
    expect(sent).toEqual([]);
    await act(async () => vi.advanceTimersByTime(1));
    expect(sent).toEqual(["choice-2"]);
    await act(async () => vi.advanceTimersByTime(80));
    expect(container.querySelector('[aria-label="Your answer: Seoul"]')?.textContent).toBe("Seoul");
  });

  it("reopens on the selection with the error when the answer fails (CA4)", async () => {
    mount(cities, async () => {
      throw new Error("The bot moved on");
    });
    act(() => tile("Seoul")?.click());
    await act(async () => vi.advanceTimersByTime(800));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("The bot moved on");
    expect(tile("Seoul")?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[aria-label^="Your answer"]')).toBeNull();
  });

  it("sends what a legacy free-text card's field holds, never approved (CA9)", async () => {
    const sent: string[] = [];
    mount({ kind: "ask", text: "Which city should I use?" }, async (text) => void sent.push(text));
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Answer"]');
    if (!field) throw new Error("no answer field");
    type(field, "Paris");
    await act(async () => container.querySelector("form")?.requestSubmit());
    expect(sent).toEqual(["Paris"]);
  });

  it("selects with a digit only from inside the card (CA12)", async () => {
    const sent: string[] = [];
    mount(cities, async (text) => void sent.push(text));
    press(document.body, "2");
    expect(tile("Seoul")?.getAttribute("aria-pressed")).toBe("false");
    press(tile("Berlin")!, "2");
    expect(tile("Seoul")?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => vi.advanceTimersByTime(650));
    expect(sent).toEqual(["choice-2"]);
  });

  it("moves focus with the arrows without selecting (CA12)", () => {
    mount(cities, async () => {});
    tile("Berlin")?.focus();
    press(tile("Berlin")!, "ArrowDown");
    expect(document.activeElement?.textContent).toBe("Seoul");
    expect(tile("Seoul")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the arrows on the tiles once Other is open (CA12)", () => {
    mount(cities, async () => {});
    act(() => tile("Other…")?.click());
    tile("Seoul")?.focus();
    press(tile("Seoul")!, "ArrowDown");
    expect(document.activeElement?.textContent).toBe("Berlin");
  });

  it("mounted again while its answer is in flight, shows it and takes no other (TM CA20)", async () => {
    const sent: string[] = [];
    const onAnswer = (text: string) => {
      sent.push(text);
      return new Promise<void>(() => {});
    };
    const show = () =>
      act(() => {
        root.render(
          <AskCard block={cities} canAnswer={true} onAnswer={onAnswer} messageId="msg-remount" />,
        );
      });
    show();
    act(() => tile("Seoul")?.click());
    await act(async () => vi.advanceTimersByTime(800));
    act(() => root.render(<div />));
    show();
    act(() => tile("Berlin")?.click());
    await act(async () => vi.advanceTimersByTime(800));
    expect({
      sent,
      answer: container.querySelector('[aria-label^="Your answer"]')?.getAttribute("aria-label"),
      tiles: container.querySelectorAll('[data-slot="option-tile"]').length,
    }).toEqual({ sent: ["choice-2"], answer: "Your answer: Seoul", tiles: 0 });
  });

  it("sends nothing when the hold ends between the card stopping waiting and its effect", async () => {
    const sent: string[] = [];
    const onAnswer = async (text: string) => void sent.push(text);
    /** A timer the event loop runs after React commits, before its passive effects. */
    function TimerBetween({ ms }: { ms: number }) {
      useLayoutEffect(() => void vi.advanceTimersByTime(ms), [ms]);
      return null;
    }
    const show = (canAnswer: boolean, timer?: number) =>
      act(() => {
        root.render(
          <>
            <AskCard
              block={cities}
              canAnswer={canAnswer}
              onAnswer={onAnswer}
              messageId="msg-race"
            />
            {timer ? <TimerBetween ms={timer} /> : null}
          </>,
        );
      });
    show(true);
    act(() => tile("Seoul")?.click());
    await act(async () => vi.advanceTimersByTime(649));
    show(false, 1);
    await act(async () => vi.advanceTimersByTime(800));
    expect({
      sent,
      bubble: container.querySelector('[aria-label^="Your answer"]'),
      line: container.querySelector('[data-testid="ask-settled"]')?.textContent,
    }).toEqual({ sent: [], bubble: null, line: "Which city should I use?·No longer active" });
  });

  it("keeps the typed answer when a digit is pressed on the field's send button (CA12)", () => {
    mount(cities, async () => {});
    act(() => tile("Other…")?.click());
    const field = () =>
      container.querySelector<HTMLInputElement>('input[aria-label="Other answer"]');
    type(field()!, "Lisbon");
    press(container.querySelector('button[type="submit"]')!, "1");
    expect({
      typed: field()?.value,
      berlin: tile("Berlin")?.getAttribute("aria-pressed"),
    }).toEqual({ typed: "Lisbon", berlin: "false" });
  });

  it("puts focus back on the chosen tile when the answer fails (CA4)", async () => {
    mount(cities, async () => {
      throw new Error("The bot moved on");
    });
    tile("Seoul")?.focus();
    act(() => tile("Seoul")?.click());
    await act(async () => vi.advanceTimersByTime(800));
    expect(document.activeElement?.textContent).toBe("Seoul");
  });

  it("puts focus back in the field when a typed answer fails (CA4)", async () => {
    mount(cities, async () => {
      throw new Error("The bot moved on");
    });
    act(() => tile("Other…")?.click());
    type(container.querySelector<HTMLInputElement>('input[aria-label="Other answer"]')!, "Lisbon");
    await act(async () => container.querySelector("form")?.requestSubmit());
    await act(async () => vi.advanceTimersByTime(800));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Other answer");
  });

  it("keeps the line breaks of the question's detail", () => {
    mount({ ...cities, detail: "Berlin: rain\nSeoul: sun" }, async () => {});
    const detail = [...container.querySelectorAll(".whitespace-pre-wrap")].find((el) =>
      el.textContent?.startsWith("Berlin: rain"),
    );
    expect(detail?.textContent).toBe("Berlin: rain\nSeoul: sun");
  });

  it("shows a label written in markdown literally, without a link (CA16)", () => {
    mount(
      {
        kind: "ask",
        text: "Pick one",
        actions: [{ id: "choice-1", label: "[Verified](https://evil.example) <b>now</b>" }],
      },
      async () => {},
    );
    expect(tile("[Verified](https://evil.example) <b>now</b>")).toBeDefined();
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("AskCard routine confirmation", () => {
  const render = (block: AskBlock) =>
    renderToStaticMarkup(
      <MemoryRouter initialEntries={["/app/g/group-1"]}>
        <AskCard
          block={block}
          canAnswer={true}
          onAnswer={async () => {}}
          messageId="msg-routine"
          botId="bot-1"
        />
      </MemoryRouter>,
    );
  const stretch = {
    id: "routine-1",
    name: "Stretch",
    schedule: "Every hour UTC",
    prompt: "Remind me to stretch",
    notify: false,
  };
  const answeredLine = (html: string) => {
    const start = html.indexOf('data-slot="framed-block-answered"');
    return start < 0
      ? null
      : html.slice(html.indexOf(">", start) + 1, html.indexOf("</div>", start));
  };

  it("confirms a routine the user asked for, settled, linking to its bot's page from a group", () => {
    const html = render(
      routineConfirmationBlock(
        "effect-1",
        {
          id: "routine-1",
          name: "Offres de la semaine",
          schedule: "Every hour UTC",
          prompt: "Résume les nouvelles offres. **Vite**",
          notify: false,
        },
        "created",
      ),
    );
    expect(html).toContain("Every hour UTC");
    expect(html).toContain('href="/app/bot-1?routine=routine-1"');
    expect(answeredLine(html)?.replace(/<[^>]+>/g, "")).toBe(
      "Routine created · Offres de la semaine",
    );
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<pre");
    expect(html).not.toContain("Needs your call");
  });

  it("confirms a change the user asked for as Routine updated", () => {
    const html = render(
      routineConfirmationBlock(
        "effect-1",
        {
          id: "routine-1",
          name: "Offres de la semaine",
          schedule: "Every hour UTC",
          prompt: "Résume les nouvelles offres.",
          notify: false,
        },
        "updated",
      ),
    );
    expect(html).toContain('href="/app/bot-1?routine=routine-1"');
    expect(answeredLine(html)?.replace(/<[^>]+>/g, "")).toBe(
      "Routine updated · Offres de la semaine",
    );
  });

  it("settles the approval card the user allowed for a routine on that routine", () => {
    const allowed: AskBlock = {
      kind: "ask",
      approvalEffectId: "effect-1",
      text: "Review before schedule_create",
      status: "answered",
      answer: "allow",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow this tool" },
        { id: "deny", label: "Deny" },
      ],
    };
    const html = render(settleRoutineAsk(allowed, stretch, "created"));
    expect(html).toContain("Every hour UTC");
    expect(html).not.toContain("Review before schedule_create");
    expect(html).toContain('href="/app/bot-1?routine=routine-1"');
    expect(answeredLine(html)?.replace(/<[^>]+>/g, "")).toBe("Routine created · Stretch");
    expect(html).not.toContain("Needs your call");
    expect(
      answeredLine(render(settleRoutineAsk(allowed, stretch, "updated")))?.replace(/<[^>]+>/g, ""),
    ).toBe("Routine updated · Stretch");
  });
});

describe("AskCard routine proposal", () => {
  const routine = {
    name: "Offres de la semaine",
    schedule: "Mondays at 09:00 Europe/Paris",
    prompt: "Résume les nouvelles offres. ![](https://e.example/p.png) [lien](https://e.example)",
    notify: false,
  };
  const card = (overrides: Partial<AskBlock> = {}): AskBlock => ({
    kind: "ask",
    approvalEffectId: "effect-1",
    proposal: "routine",
    text: "Je m'en occupe chaque lundi matin ?",
    detail: "name: Offres de la semaine",
    status: "pending",
    actions: [
      { id: "allow", label: "Create routine", outcome: "created" },
      { id: "deny", label: "Not now", outcome: "cancelled" },
    ],
    routine,
    ...overrides,
  });
  const render = (block: AskBlock) =>
    renderToStaticMarkup(
      <MemoryRouter initialEntries={["/app/bot-1"]}>
        <AskCard
          block={block}
          canAnswer={true}
          onAnswer={async () => {}}
          messageId="msg-routine"
          botId="bot-1"
        />
      </MemoryRouter>,
    );
  const answeredLine = (html: string) => {
    const start = html.indexOf('data-slot="framed-block-answered"');
    return start < 0
      ? undefined
      : html.slice(html.indexOf(">", start) + 1, html.indexOf("</div>", start));
  };

  it("shows the bot's question, the routine as plain text, then Not now and Create routine", () => {
    const html = render(card());
    expect(html).toContain("Je m&#x27;en occupe chaque lundi matin ?");
    expect(html).not.toContain("Needs your call");
    const preview = html.slice(html.indexOf('data-testid="routine-preview"'));
    expect(preview).toContain("Offres de la semaine");
    expect(preview).toContain("Mondays at 09:00 Europe/Paris");
    expect(preview).toContain("Résume les nouvelles offres. ![](https://e.example/p.png)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<pre");
    const buttons = [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) =>
      m[1]?.replace(/<svg.*?<\/svg>/g, ""),
    );
    expect(buttons).toEqual(["Not now", "Create routine"]);
    expect(html).not.toContain("data-consequential");
    expect(preview).not.toContain("Notifies you each run");
  });

  it("says a routine notifies on each run, in one line", () => {
    const html = render(card({ routine: { ...routine, notify: true } }));
    const preview = html.slice(html.indexOf('data-testid="routine-preview"'));
    expect(preview).toContain("Notifies you each run");
  });

  it("shows a question the bot wrote as plain text, never as markdown", () => {
    const html = render(card({ text: "On le fait **chaque** lundi ?" }));
    expect(html).toContain("On le fait **chaque** lundi ?");
    expect(html).not.toContain("<strong>");
  });

  it("links a created routine to its editor, without the preview", () => {
    const html = render(
      card({
        status: "answered",
        answer: "allow",
        created: { kind: "routine", id: "routine-1", label: "Offres de la semaine" },
      }),
    );
    expect(html).toContain('href="/app/bot-1?routine=routine-1"');
    expect(answeredLine(html)?.replace(/<[^>]+>/g, "")).toBe(
      "Routine created · Offres de la semaine",
    );
    expect(html).not.toContain('data-testid="routine-preview"');
  });

  it.each([
    ["Not now", { answer: "deny" }],
    ["Not now", { answer: "dismissed" }],
    ["Couldn't create", { answer: "allow", failed: true as const }],
    ["Creating…", { answer: "allow" }],
    ["Answered", { answer: "something-else" }],
  ])("settles on %s", (expected, answer) => {
    const html = render(card({ status: "answered", ...answer }));
    expect(answeredLine(html)?.replace(/&#x27;/g, "'")).toBe(expected);
  });
});
