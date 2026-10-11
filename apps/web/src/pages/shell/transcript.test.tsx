// @vitest-environment jsdom

import { SessionEntrySchema } from "@rakazo/contracts";
import { projectThreadView } from "@rakazo/core";
import type { ReactNode } from "react";
import { act, createRef } from "react";
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

const api = vi.hoisted(() => ({ sessionEntries: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { sessions: { entries: api.sessionEntries } } }));

import streamedReply from "../../../../../packages/core/src/session-log/fixtures/streamed-reply.jsonl?raw";
import { Transcript } from "./transcript";

const fixture = streamedReply
  .trim()
  .split("\n")
  .map((line) => SessionEntrySchema.parse(JSON.parse(line)));

const helperSession = [
  {
    id: "scout-00",
    sessionId: "ses_scout",
    seq: 0,
    parentId: null,
    ts: "2026-10-10T09:00:04.000Z",
    type: "user.message",
    payload: { blocks: [{ kind: "text", text: "List competitors" }], source: "app" },
  },
  {
    id: "scout-01",
    sessionId: "ses_scout",
    seq: 1,
    parentId: "scout-00",
    ts: "2026-10-10T09:00:04.500Z",
    botId: "bot_ada",
    runId: "run_scout",
    type: "assistant.text",
    payload: { blocks: [{ kind: "text", text: "Globex and Initech" }] },
  },
].map((entry) => SessionEntrySchema.parse(entry));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  api.sessionEntries.mockReset().mockResolvedValue({ entries: helperSession });
  Element.prototype.scrollTo = () => undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderThread(lastEntry: number) {
  await act(async () => {
    root.render(
      <Transcript
        scrollRef={createRef<HTMLDivElement>()}
        artifactTarget={{ botId: "bot_ada" }}
        inGroup={false}
        view={projectThreadView(fixture.slice(0, lastEntry + 1))}
        olderCursor={null}
        loadingOlder={false}
        running={false}
        workingBots={[]}
        onLoadOlder={() => undefined}
        onOpenBot={() => undefined}
        onAnswer={async () => undefined}
        onReply={() => undefined}
        onEdit={() => undefined}
        rewindFromItemId={null}
        onReact={async () => undefined}
        onJumpToMessage={() => undefined}
        onOpenPeerMessages={() => undefined}
        peerBot={() => undefined}
        onRefresh={async () => undefined}
        onBotChanged={async () => undefined}
        onAddRoutine={() => undefined}
        voiceReady={false}
        speakingMessageId={null}
        onSpeak={() => undefined}
      />,
    );
  });
}

const text = (selector: string) =>
  [...document.querySelectorAll(selector)].map((element) => element.textContent);

describe("the transcript", () => {
  it("draws a run card per run, the helper's card and a rewind divider from the rows", async () => {
    await renderThread(17);

    expect(text('[data-testid="run-card"]')).toEqual(["emulator-1 · Completed"]);
    expect(text('[data-testid="task-card"] span[dir="auto"]')).toEqual(["scout"]);
    expect(text('[data-testid="thread-divider"]')).toEqual(["Message edited"]);
    expect(text('[data-testid="message-user-bubble"]')).toEqual([
      "Find three competitors and summarize Acme's site",
      "Yes",
    ]);
  });

  it("opens a finished helper's own session, read-only", async () => {
    await renderThread(9);

    const card = document.querySelector<HTMLButtonElement>('[data-testid="task-card"] button');
    await act(async () => card?.click());

    expect(api.sessionEntries).toHaveBeenCalledWith(
      { sessionId: "ses_scout" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const session = document.querySelector('[data-testid="session-view"]');
    expect(session?.textContent).toContain("Globex and Initech");
    expect(session?.querySelector('[data-testid="message-hover-rail"]')).toBeNull();
  });
});
