import type { MessageBlock } from "@rakazo/contracts";
import { SessionEntrySchema } from "@rakazo/contracts";
import { drawsNothing, projectThreadView } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  hasVisibleMessagePresentation,
  messagePresentationSegments,
  skillLineRoute,
  skillLineSegment,
  visibleMessageBlocks,
} from "./message-presentation";

describe("mobile message presentation", () => {
  it("keeps only the blocks the thread draws", () => {
    const text = { kind: "text", text: "Hello" } as MessageBlock;
    const steps = {
      kind: "steps",
      steps: [{ label: "Read file", count: 1 }],
    } as MessageBlock;
    const activity = { kind: "progress", text: "Reading", activity: true } as MessageBlock;

    expect(visibleMessageBlocks([text, steps, activity])).toEqual([text]);
    expect(visibleMessageBlocks([text, steps, activity], true)).toEqual([text, steps]);
  });

  it("hides completed tool activity", () => {
    const blocks = [
      {
        kind: "steps",
        steps: [
          { label: "Read file", count: 1 },
          { label: "Message bot", count: 1 },
        ],
      },
      { kind: "bot_message_sent", toBotId: "b", toBotName: "Research", text: "Go" },
    ] as MessageBlock[];

    expect(messagePresentationSegments(blocks)).toEqual([
      {
        kind: "content",
        blocks: [{ kind: "bot_message_sent", toBotId: "b", toBotName: "Research", text: "Go" }],
      },
    ]);
    expect(
      hasVisibleMessagePresentation([
        { kind: "steps", steps: [{ label: "Message bot", count: 1 }] },
      ]),
    ).toBe(false);
  });

  it("keeps steps-only messages visible when the setting is on", () => {
    const steps = [{ kind: "steps", steps: [{ label: "Read file", count: 1 }] }] as MessageBlock[];

    expect(hasVisibleMessagePresentation(steps)).toBe(false);
    expect(hasVisibleMessagePresentation(steps, true)).toBe(true);
    expect(
      hasVisibleMessagePresentation(
        [{ kind: "progress", text: "Using browser", activity: true }],
        true,
      ),
    ).toBe(false);
  });

  it("hides marked activity without treating Using narration as a tool", () => {
    const activity = { kind: "progress", text: "Using browser", activity: true } as const;
    const narration = { kind: "progress", text: "Using browser is optional." } as const;

    expect(messagePresentationSegments([activity, narration])).toEqual([
      { kind: "content", blocks: [narration] },
    ]);

    const mixed: Extract<MessageBlock, { kind: "progress" }> = {
      kind: "progress",
      text: "Let me check",
      pendingToolNames: ["browser"],
    };
    expect(messagePresentationSegments([mixed])).toEqual([{ kind: "content", blocks: [mixed] }]);
  });

  it("keeps each turn of words apart around hidden tool activity", () => {
    const tool: Extract<MessageBlock, { kind: "steps" }> = {
      kind: "steps",
      steps: [{ label: "Read file", count: 1 }],
    };

    expect(
      messagePresentationSegments([
        { kind: "text", text: "Checking." },
        tool,
        { kind: "text", text: "Done." },
      ]),
    ).toEqual([
      { kind: "content", blocks: [{ kind: "text", text: "Checking." }] },
      { kind: "content", blocks: [{ kind: "text", text: "Done." }] },
    ]);

    expect(
      messagePresentationSegments([
        { kind: "steps", steps: [{ label: "Message bot", count: 1 }] },
        { kind: "text", text: "Done." },
      ]),
    ).toEqual([{ kind: "content", blocks: [{ kind: "text", text: "Done." }] }]);
  });

  it("keeps shown steps where the bot produced them, between its words", () => {
    const tool: Extract<MessageBlock, { kind: "steps" }> = {
      kind: "steps",
      steps: [{ label: "Read file", count: 1 }],
    };

    expect(
      messagePresentationSegments(
        [{ kind: "text", text: "Checking." }, tool, { kind: "text", text: "Done." }],
        true,
      ),
    ).toEqual([
      { kind: "content", blocks: [{ kind: "text", text: "Checking." }] },
      { kind: "steps", block: tool },
      { kind: "content", blocks: [{ kind: "text", text: "Done." }] },
    ]);
  });
});

describe("skill lines", () => {
  const uid = "0123456789abcdef0123456789abcdef";
  const line = (change: "learned" | "updated" | "deleted") =>
    ({
      kind: "skill_source",
      skillUid: uid,
      skillId: "user:coffee",
      name: "Coffee",
      change,
    }) as const;

  it("draws a message made only of skill lines, and keeps the lines beside its text", () => {
    expect(hasVisibleMessagePresentation([line("learned")])).toBe(true);
    const blocks = [{ kind: "text", text: "Done." }, line("updated")] as MessageBlock[];
    expect(visibleMessageBlocks(blocks)).toEqual(blocks);
    expect(messagePresentationSegments(blocks)).toEqual([{ kind: "content", blocks }]);
  });

  it("opens the skill by its id, also from a line stored with a uid, or Skills when it is gone", async () => {
    const { skillUid: _, ...withoutUid } = line("updated");
    const catalog = async () => [{ id: "builtin:routines" }, { id: "user:coffee" }];
    const opened = { pathname: "/bot-skill", params: { skillId: "user:coffee" } };
    await expect(skillLineRoute(withoutUid, catalog)).resolves.toEqual(opened);
    await expect(skillLineRoute(line("learned"), catalog)).resolves.toEqual(opened);
    await expect(skillLineRoute(line("updated"), async () => [])).resolves.toEqual({
      pathname: "/skills",
    });
  });

  it("hangs the lines under the last segment that draws text, else stands them alone", () => {
    expect(skillLineSegment(["Done."])).toBe(0);
    expect(skillLineSegment(["Reading.", "Done.", ""])).toBe(1);
    expect(skillLineSegment([""])).toBe(-1);
    expect(skillLineSegment([])).toBe(-1);
  });

  it("draws a finished run as its bubbles alone, with no run line between them", () => {
    const entries = [
      { type: "user.message", payload: { blocks: [{ kind: "text", text: "Hi" }], source: "app" } },
      {
        runId: "run_1",
        type: "run.started",
        payload: {
          trigger: { kind: "direct" },
          model: { provider: "local", id: "emulator-1" },
          effort: null,
        },
      },
      {
        runId: "run_1",
        type: "assistant.text",
        payload: { blocks: [{ kind: "text", text: "Hello" }] },
      },
      {
        runId: "run_1",
        type: "run.finished",
        payload: { status: "completed", usage: { inputTokens: 1, outputTokens: 1 } },
      },
    ].map((entry, seq) =>
      SessionEntrySchema.parse({
        id: `e_${seq}`,
        seq,
        parentId: seq === 0 ? null : `e_${seq - 1}`,
        ts: `2026-10-10T09:00:0${seq}.000Z`,
        sessionId: "ses_main",
        botId: "bot_ada",
        ...entry,
      }),
    );
    const rows = projectThreadView(entries, {
      rendersNothing: (item) =>
        drawsNothing(item, (blocks) => hasVisibleMessagePresentation(blocks)),
    }).rows;
    expect(rows.map((row) => [row.item.kind, row.item.id, row.marker !== undefined])).toEqual([
      ["message", "e_0", true],
      ["message", "e_2", false],
    ]);
  });
});
