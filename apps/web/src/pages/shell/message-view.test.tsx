// @vitest-environment jsdom

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
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
vi.mock("../../lib/rpc", () => ({ rpc: {} }));

import { setDebugMode } from "../../lib/debug-mode";
import type { MessageItem } from "../../lib/thread-items";
import { MessageView } from "./message-view";

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
  setDebugMode(false);
  vi.unstubAllGlobals();
});

describe("a bot's narration", () => {
  it.each([
    [true, ["Let me look.", "1 step", "Found it.Skill learned · Search"]],
    [false, ["Let me look.", "Found it.Skill learned · Search"]],
  ])(
    "draws its words and its steps (shown: %s) in the order the bot produced them",
    async (showSteps, expected) => {
      setDebugMode(showSteps);
      const message: MessageItem = {
        kind: "message",
        id: "m1" as MessageItem["id"],
        ts: "2026-10-10T08:30:00.000Z",
        role: "bot",
        botId: "bot1",
        blocks: [
          { kind: "text", text: "Let me look." },
          {
            kind: "steps",
            steps: [{ label: "Search", count: 1 }],
          },
          { kind: "text", text: "Found it." },
          {
            kind: "skill_source",
            skillUid: "0123456789abcdef0123456789abcdef",
            skillId: "user:Search",
            name: "Search",
            change: "learned",
          },
        ],
      };
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
            peerBot={() => undefined}
            onRefresh={async () => undefined}
            onBotChanged={async () => undefined}
            onAddRoutine={() => undefined}
          />,
        );
      });

      const drawn = container.querySelectorAll(
        '[data-slot="message-row-bubble"], [data-testid="agent-steps-toggle"]',
      );
      expect([...drawn].map((node) => node.textContent)).toEqual(expected);
    },
  );
});
