// @vitest-environment jsdom

import type { ThreadItem } from "@tangow/contracts";
import { ThreadItemSchema } from "@tangow/contracts";
import type { ThreadRow } from "@tangow/core";
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

import type { RowContext } from "./thread-row";
import { ThreadRowBody } from "./thread-row";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let opened: unknown[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  opened = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(row: Omit<ThreadRow, "firstOfGroup" | "lastOfGroup" | "reactions">) {
  const context = {
    artifactTarget: { botId: "bot_ada" },
    inGroup: false,
    waiting: null,
    peerBot: () => undefined,
    onOpenSession: (target: unknown) => opened.push(target),
  } as unknown as RowContext;
  await act(async () => {
    root.render(
      <ThreadRowBody
        row={{ ...row, firstOfGroup: true, lastOfGroup: true, reactions: [] }}
        context={context}
        chrome="row"
        showAuthor
        showAvatar
        arrivesLive={false}
      />,
    );
  });
}

const routine = ThreadItemSchema.parse({
  kind: "routine",
  id: "e_1",
  ts: "2026-10-10T09:00:00.000Z",
  runId: "run_digest",
  botId: "bot_ada",
  sessionId: "ses_digest",
  routineId: "rtn_digest",
  name: "Morning brief",
  finished: { status: "completed", result: "Invoice due ![x](https://example.test/a.png)" },
}) as Extract<ThreadItem, { kind: "routine" }>;

describe("a routine run with words", () => {
  it("reads as a bubble under the routine's name, which opens the run, with no remote image", async () => {
    await render({
      item: routine,
      routine: { kind: "message", text: "Invoice due ![x](https://example.test/a.png)" },
    });
    const name = container.querySelector<HTMLElement>('[data-testid="item-origin"]')!;
    const bubble = container.querySelector('[data-testid="routine-message"]')!;
    expect(name.textContent).toBe("Morning brief");
    expect(name.compareDocumentPosition(bubble)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(bubble.textContent).toContain("Invoice due");
    expect(container.querySelectorAll("img").length).toBe(0);
    expect(container.querySelector('[data-testid="routine-run-line"]')).toBeNull();

    await act(async () => name.click());
    expect(opened).toEqual([{ kind: "run", runId: "run_digest", title: "Morning brief" }]);
  });
});
