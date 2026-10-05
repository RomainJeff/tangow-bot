import { i18n } from "@lingui/core";
import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkTreeContext } from "../../components/work-tree/context";
import { taskNode } from "../../lib/work-tree.fixtures";

// The node test run has no Lingui vite transform; substitute the runtime tags with plain
// interpolation. The guarantee under test is what the message draws, not the catalog machinery.
function identityTag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}
vi.mock("@lingui/core/macro", () => ({ t: identityTag }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: identityTag }),
  Trans: ({ children }: { children?: ReactNode }) => children,
  Plural: ({ one, other, value }: { one: string; other: string; value: number }) =>
    value === 1 ? one : other,
}));

import { MessageView } from "./message-view";

i18n.activate("en");

const blocks: MessageBlock[] = [
  {
    kind: "card",
    lines: [
      { k: "purpose", v: "work_return" },
      { k: "workId", v: "work-1" },
      { k: "outcome", v: "result" },
    ],
  },
  {
    kind: "ask",
    text: "Publish the brief?",
    status: "pending",
    actions: [{ id: "allow", label: "Allow once" }],
  },
  { kind: "choice", question: "Which focus?", options: [{ id: "a", letter: "A", label: "Sales" }] },
  {
    kind: "app_connect",
    provider: "gmail",
    name: "Gmail",
    description: "Read mail",
    logo: null,
    status: "pending",
  },
  {
    kind: "mcp_approval",
    name: "Search server",
    serverId: "server-1",
    transport: "streamable_http",
    endpoint: "https://example.test/mcp",
    needsOAuth: true,
  },
];

const message: ThreadMessage = {
  id: "message-1",
  threadId: "thread-work",
  seq: 1,
  role: "bot",
  blocks,
  createdAt: "2026-10-02T08:00:00.000Z",
};

function render(readOnly: boolean) {
  return renderToStaticMarkup(
    <WorkTreeContext.Provider
      value={{
        tasks: [taskNode("work-1")],
        openCard: null,
        toggle: () => undefined,
        errorFor: () => null,
        onCancel: () => undefined,
        onClose: () => undefined,
        onViewThread: () => undefined,
      }}
    >
      <MessageView
        artifactTarget={{ botId: "bot-specialist" }}
        chrome="row"
        inGroup={false}
        showAuthor={false}
        showAvatar={false}
        canAnswer={false}
        readOnly={readOnly}
        message={message}
        onAnswer={async () => undefined}
        onOpenBot={() => undefined}
        onOpenPeerMessages={() => undefined}
        peerBot={() => ({ color: "#000", name: "Researcher" })}
        onRefresh={async () => undefined}
        onBotChanged={async () => undefined}
        onAddRoutine={() => undefined}
      />
    </WorkTreeContext.Provider>,
  );
}

describe("MessageView read only", () => {
  it("draws the cards that take an action as plain lines, with no control and no task link", () => {
    // The same message is actionable, with its task link, in the thread that owns it.
    const owned = render(false);
    expect(owned).toContain("<button");
    expect(owned).toContain("task-tree-disclosure");

    const html = render(true);
    for (const text of ["Publish the brief?", "Which focus?", "Gmail", "Search server"]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("<button");
    expect(html).not.toContain("task-tree-disclosure");
  });
});
