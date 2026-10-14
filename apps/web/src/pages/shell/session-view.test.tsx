// @vitest-environment jsdom

import { SessionEntrySchema } from "@rakazo/contracts";
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

const entries = [
  {
    sessionId: "ses_main",
    runId: "run_digest",
    type: "routine.started",
    payload: {
      sessionId: "ses_digest",
      routineId: "rtn_digest",
      name: "Digest",
      trigger: "routine",
      scheduledAt: "2026-10-10T09:00:00.000Z",
      model: { provider: "local", id: "emulator-1" },
    },
  },
  {
    sessionId: "ses_digest",
    runId: "run_digest",
    type: "assistant.text",
    payload: { blocks: [{ kind: "text", text: "Three new invoices" }] },
  },
  {
    sessionId: "ses_main",
    runId: "run_digest",
    type: "routine.finished",
    payload: {
      status: "completed",
      usage: { inputTokens: 1, outputTokens: 1 },
      result: "Three new invoices",
    },
  },
].map((entry, seq) =>
  SessionEntrySchema.parse({
    id: `e_${seq}`,
    seq,
    parentId: seq === 0 ? null : `e_${seq - 1}`,
    ts: `2026-10-10T09:00:0${seq}.000Z`,
    botId: "bot_ada",
    ...entry,
  }),
);
let served = entries;
vi.mock("../../lib/rpc", () => ({
  rpc: {
    runs: { entries: async () => ({ entries: served }) },
    sessions: { entries: async () => ({ entries }) },
  },
}));

import type { SessionViewTarget } from "../../lib/thread-items";
import { SessionView } from "./session-view";
import type { RowContext } from "./thread-row";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  served = entries;
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function open(target: SessionViewTarget) {
  const context = {
    artifactTarget: { botId: "bot_ada" },
    inGroup: false,
    queuedRunIds: new Set(),
    peerBot: () => undefined,
    onOpenBot: () => undefined,
    onOpenPeerMessages: () => undefined,
    onRefresh: async () => undefined,
    onBotChanged: async () => undefined,
    onAddRoutine: () => undefined,
  } as unknown as Parameters<typeof SessionView>[0]["context"] & Partial<RowContext>;
  await act(async () => {
    root.render(<SessionView target={target} context={context} onClose={() => undefined} />);
  });
  return document.querySelector('[data-testid="session-view"]')!;
}

describe("a session view", () => {
  it("leaves out the line of the routine run it shows, and keeps it elsewhere", async () => {
    const run = await open({ kind: "run", runId: "run_digest", title: "Digest" });
    expect(run.textContent).toContain("Three new invoices");
    expect(run.querySelectorAll('[data-testid="routine-run-line"]').length).toBe(0);

    act(() => root.unmount());
    root = createRoot(container);
    const session = await open({ kind: "session", sessionId: "ses_main" as never, title: "Main" });
    expect(session.querySelectorAll('[data-testid="routine-run-line"]').length).toBe(1);
  });

  it("shows the report of a run that ended without a closing message, once", async () => {
    served = entries.filter((entry) => entry.type !== "assistant.text");
    const card = await open({ kind: "run", runId: "run_digest", title: "Digest" });
    expect(card.textContent?.split("Three new invoices").length).toBe(2);

    act(() => root.unmount());
    root = createRoot(container);
    served = entries;
    const closed = await open({ kind: "run", runId: "run_digest", title: "Digest" });
    expect(closed.textContent?.split("Three new invoices").length).toBe(2);
  });
});
