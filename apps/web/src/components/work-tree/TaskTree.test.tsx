import type { TaskApproval, TaskTreeNode } from "@rakazo/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The node test run has no Lingui vite transform; substitute the runtime tags with plain
// interpolation. The guarantee under test is what each line shows, not the catalog machinery.
function identityTag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}
vi.mock("@lingui/core/macro", () => ({ t: identityTag }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: identityTag }),
  Trans: ({ children }: { children?: unknown }) => children,
}));

import { taskNode as node } from "../../lib/work-tree.fixtures";
import { TaskTree } from "./TaskTree";

const approval = (status: TaskApproval["status"]): TaskApproval => ({
  effectId: "effect-1",
  summary: "Publish the brief",
  status,
  decidedBy: status === "pending" ? null : "user",
});

function render(nodes: TaskTreeNode[], options: { deciderName?: string; error?: string } = {}) {
  return renderToStaticMarkup(
    <TaskTree
      nodes={nodes}
      deciderName={options.deciderName}
      errorFor={() => options.error ?? null}
      onCancel={() => undefined}
      onClose={() => undefined}
      onViewThread={() => undefined}
    />,
  );
}

describe("TaskTree", () => {
  it("shows each task's specialist, state, engine and why it was chosen", () => {
    const html = render([
      node("Researcher", { harness: "codex-native", harnessSource: "explicit" }),
      node("Writer", { harnessSource: "judgment" }),
    ]);
    expect(html).toContain("Researcher");
    expect(html).toContain("Running");
    expect(html).toContain("Codex · chosen explicitly");
    expect(html).toContain("Rakazo · picked automatically");
  });

  it("says nothing about the choice of a task created before it was recorded", () => {
    const html = render([node("Writer", { harnessSource: null })]);
    expect(html).toContain("Rakazo");
    expect(html).not.toContain("Rakazo ·");
  });

  it("nests what a specialist delegated under its own line", () => {
    const html = render([node("Chief task", { children: [node("Helper")] })]);
    expect(html.match(/data-testid="task-tree-line"/g)).toHaveLength(2);
    expect(html.indexOf("Chief task")).toBeLessThan(html.indexOf("Helper"));
  });

  it("folds a result until it is opened, and never offers one that has no text", () => {
    const withText = render([
      node("A", {
        status: "closed",
        result: { runId: "run-1", outcome: "result", text: "Twelve suppliers found" },
      }),
    ]);
    expect(withText).toContain("Closed");
    expect(withText).toContain("Result");
    expect(withText).toContain('aria-expanded="false"');
    expect(withText).not.toContain("Twelve suppliers found");
    const withoutText = render([
      node("A", { result: { runId: "run-1", outcome: "failed", text: null } }),
    ]);
    expect(withoutText).toContain("Failed");
    expect(withoutText).not.toContain(">Result<");
  });

  it("names every line's actions menu after its specialist", () => {
    const html = render([node("Researcher")]);
    expect(html).toContain('aria-label="Actions for Researcher"');
  });

  it("shows a pending approval as waiting for the owner, with no action of its own", () => {
    const html = render([node("Writer", { approvals: [approval("pending")] })]);
    expect(html).toContain("Needs your call");
    expect(html).toContain("Publish the brief");
    expect(html).not.toContain("Allow once");
    expect(html).not.toContain("Deny");
  });

  it("shows a specialist waiting on a question as needing input", () => {
    const html = render([node("Writer", { working: true, waitingInput: true })]);
    expect(html).toContain("Needs input");
    expect(html).not.toContain("Running");
  });

  it("states who settled an approval", () => {
    const allowed = render([node("Writer", { approvals: [approval("allowed")] })], {
      deciderName: "Ada",
    });
    expect(allowed).toContain("Publish the brief · allowed by Ada");
    const denied = render([node("Writer", { approvals: [approval("denied")] })], {
      deciderName: "Ada",
    });
    expect(denied).toContain("Publish the brief · denied by Ada");
    const always = render([node("Writer", { approvals: [approval("always_allowed")] })], {
      deciderName: "Ada",
    });
    expect(always).toContain("Publish the brief · always allowed by Ada");
  });

  it("shows a failed action on the line it concerns", () => {
    const html = render([node("Writer")], { error: "Delegated work is still working." });
    expect(html).toContain("Delegated work is still working.");
  });
});
