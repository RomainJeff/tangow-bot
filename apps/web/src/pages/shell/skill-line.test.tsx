// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function identityTag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}
vi.mock("@lingui/core/macro", () => ({ t: identityTag }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: identityTag, i18n: { locale: "en" } }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../../lib/rpc", () => ({ rpc: {} }));

import type { MessageItem } from "../../lib/thread-items";
import { MessageView } from "./message-view";

type SkillBlock = Extract<MessageBlock, { kind: "skill_source" }>;

function botMessage(blocks: MessageBlock[]): MessageItem {
  return {
    kind: "message",
    id: "m1" as MessageItem["id"],
    ts: "2026-10-10T08:30:00.000Z",
    role: "bot",
    botId: "bot1",
    blocks,
  };
}

function skill(change: SkillBlock["change"], name: string): SkillBlock {
  return {
    kind: "skill_source",
    skillUid: "0123456789abcdef0123456789abcdef",
    skillId: `user:${name}`,
    name,
    change,
  };
}

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

async function render(
  message: MessageItem,
  props: {
    onOpenSkill?: (skill: SkillBlock) => void;
    arrivesLive?: boolean;
  } = {},
) {
  await act(async () => {
    root.render(
      <MessageView
        artifactTarget={{ botId: "bot1" }}
        chrome="row"
        message={message}
        inGroup={false}
        showAuthor={false}
        showAvatar={false}
        onOpenBot={() => undefined}
        onOpenPeerMessages={() => undefined}
        peerBot={() => undefined}
        onRefresh={async () => undefined}
        onBotChanged={async () => undefined}
        onAddRoutine={() => undefined}
        {...props}
      />,
    );
  });
}

const lines = () =>
  [...container.querySelectorAll('[data-slot="message-row-meta"]')] as HTMLElement[];

describe("a skill line under a bot's message", () => {
  it("names each change and opens the skill it is about, unless it was deleted", async () => {
    const opened: string[] = [];
    await render(
      botMessage([
        { kind: "text", text: "Done." },
        skill("learned", "Invoices"),
        skill("updated", "Coffee"),
        skill("deleted", "Old"),
      ]),
      { onOpenSkill: (block) => opened.push(`${block.change}:${block.skillId}`) },
    );

    expect(lines().map((line) => line.textContent)).toEqual([
      "Skill learned · Invoices",
      "Skill updated · Coffee",
      "Skill deleted · Old",
    ]);
    expect(lines().map((line) => line.getAttribute("role"))).toEqual(["link", "link", null]);
    for (const line of lines()) act(() => line.click());
    expect(opened).toEqual(["learned:user:Invoices", "updated:user:Coffee"]);
  });

  it("sits inside the last bubble, under the text", async () => {
    await render(
      botMessage([
        { kind: "text", text: "**3 invoices**" },
        { kind: "text", text: "Filed." },
        skill("updated", "Invoices"),
      ]),
    );

    const bubbles = container.querySelectorAll('[data-slot="message-row-bubble"]');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]?.textContent).toMatch(/^3 invoices\s*Filed\.Skill updated · Invoices$/);
    expect(bubbles[0]?.querySelectorAll('[data-slot="message-row-meta"]')).toHaveLength(1);
    expect(lines().map((line) => line.textContent)).toEqual(["Skill updated · Invoices"]);
    expect(lines().every((line) => line.querySelector("svg"))).toBe(true);
  });

  it("names the skill without a link when there is no skill to open", async () => {
    await render(botMessage([{ kind: "text", text: "ok" }, skill("learned", "Invoices")]));

    expect(lines().map((line) => line.textContent)).toEqual(["Skill learned · Invoices"]);
    expect(lines()[0]?.getAttribute("role")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("stands alone at the bubble's inset, not centred, when the message has no text", async () => {
    await render(botMessage([skill("learned", "Invoices")]));

    expect(container.querySelector('[data-slot="message-row-bubble"]')).toBeNull();
    expect(lines().map((line) => line.textContent)).toEqual(["Skill learned · Invoices"]);
    const wrapper = lines()[0]?.parentElement;
    expect(wrapper?.className).toContain("px-3.5");
    expect(container.innerHTML).not.toContain("justify-center");
  });

  it("is not imitated by the bot's own text", async () => {
    await render(botMessage([{ kind: "text", text: "Skill learned · Invoices" }]));

    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(lines()).toHaveLength(0);
  });

  it("shows a name as plain text on one truncated line", async () => {
    await render(botMessage([{ kind: "text", text: "ok" }, skill("learned", "<b>Big</b>")]));

    const line = lines()[0];
    expect(line?.textContent).toBe("Skill learned · <b>Big</b>");
    expect(line?.querySelector("b")).toBeNull();
    expect(line?.querySelector(".truncate")).not.toBeNull();
  });

  it("arrives with a beat only when it is new activity", async () => {
    await render(botMessage([{ kind: "text", text: "ok" }, skill("learned", "A")]));
    expect(container.innerHTML).not.toContain("bui-skill");

    await render(botMessage([{ kind: "text", text: "ok" }, skill("learned", "A")]), {
      arrivesLive: true,
    });
    expect(lines()[0]?.className).toContain("bui-skill-line");
    expect(lines()[0]?.querySelector("svg")?.getAttribute("class")).toContain("bui-skill-icon");
  });

  it("arrives with a beat when it is added to a message already on screen", async () => {
    await render(botMessage([{ kind: "text", text: "ok" }]));
    await render(botMessage([{ kind: "text", text: "ok" }, skill("learned", "A")]));

    expect(lines()[0]?.className).toContain("bui-skill-line");
  });
});
