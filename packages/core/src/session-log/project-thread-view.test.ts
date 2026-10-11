import { readFileSync } from "node:fs";
import type { ProductEvent, SessionEntry } from "@rakazo/contracts";
import { SessionEntrySchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { linkEntries } from "./fixtures/read-fixture.js";
import type { ProgressLayer, ThreadEntries } from "./project-thread-view.js";
import {
  appendedEntries,
  applyEntryEvent,
  mergeEntries,
  projectThreadView,
  reduceProgressLayer,
  threadEntriesOf,
  visibleEntries,
  withOlderEntries,
  withRefreshedEntries,
} from "./project-thread-view.js";

const streamed = readFileSync(new URL("./fixtures/streamed-reply.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => SessionEntrySchema.parse(JSON.parse(line)));
const upTo = (last: number) => streamed.slice(0, last + 1);

const model = { provider: "emulator", id: "emulator-1" };
const at = (second: number) => `2026-10-10T09:00:${String(second).padStart(2, "0")}.000Z`;
const text = (value: string) => [{ kind: "text", text: value }];
const ada = { botId: "bot_ada", runId: "run_str_1" };
const alone = { firstOfGroup: true, lastOfGroup: true, reactions: [] };

function event(type: string, payload: Record<string, unknown>, runId?: string): ProductEvent {
  return {
    id: `evt-${type}`,
    spaceId: "space_1",
    threadId: "thread_1",
    botId: "bot_ada",
    seq: 1,
    type,
    ...(runId ? { runId } : {}),
    createdAt: at(5),
    payload,
  } as ProductEvent;
}

function streamedProgress(runId: string, ...deltas: string[]): ProgressLayer {
  return deltas.reduce<ProgressLayer>(
    (layer, delta) => reduceProgressLayer(layer, event("thread.progress", { delta }, runId)),
    new Map(),
  );
}

const firstMessage = {
  item: {
    kind: "message",
    role: "user",
    id: "str-00",
    ts: at(0),
    blocks: text("Find three competitors and summarize Acme's site"),
    clientNonce: "nonce-find",
    source: "app",
  },
  ...alone,
  marker: { at: at(0), withTime: true },
  messageId: "str-00",
};
const search = {
  label: "Web search",
  count: 1,
  calls: [
    {
      name: "web_search",
      input: '{"query":"Acme competitors"}',
      output: "Globex, Initech",
      id: "call_search",
    },
  ],
};
const scoutCall = (output: string) => ({
  label: "Run subagent",
  count: 1,
  calls: [
    {
      name: "run_subagent",
      input: '{"name":"scout","task":"List competitors"}',
      output,
      id: "call_scout",
    },
  ],
});
const finishedRun = {
  item: {
    kind: "run",
    id: "str-01",
    ts: at(1),
    ...ada,
    trigger: { kind: "message", entryId: "str-00" },
    model,
    effort: null,
    finished: {
      outcome: { status: "completed", usage: { inputTokens: 1500, outputTokens: 40 } },
      durationMs: 9000,
    },
  },
  ...alone,
};
const answeredWork = {
  item: {
    kind: "message",
    role: "bot",
    id: "str-02",
    ts: at(2),
    ...ada,
    blocks: [
      { kind: "steps", steps: [search, scoutCall("Globex, Initech")], durationMs: 9000 },
      { kind: "text", text: "Acme, Globex, Initech" },
      { kind: "ask", text: "Compare prices too?", status: "answered" },
    ],
  },
  ...alone,
  messageId: "str-06",
};
const scout = {
  item: {
    kind: "subagent",
    id: "str-05",
    ts: at(5),
    runId: "run_str_1",
    callId: "call_scout",
    sessionId: "ses_scout",
    name: "scout",
    model,
    task: "List competitors",
    status: "completed",
    result: "Globex, Initech",
    usage: { inputTokens: 300, outputTokens: 6 },
  },
  ...alone,
};
const yes = {
  item: {
    kind: "message",
    role: "user",
    id: "str-08",
    ts: at(8),
    blocks: text("Yes"),
    replyTo: { entryId: "str-07" },
    clientNonce: "nonce-yes",
    source: "app",
  },
  ...alone,
  messageId: "str-08",
};
const summary = (...blocks: object[]) => ({
  item: {
    kind: "message",
    role: "bot",
    id: "str-09",
    ts: at(9),
    ...ada,
    blocks: [{ kind: "text", text: "Summary of https://acme.example" }, ...blocks],
  },
  ...alone,
  messageId: "str-09",
});

describe("projectThreadView on a streamed reply", () => {
  it("shows the open run's steps, its helper at work and the streamed text mid-run", () => {
    const view = projectThreadView(upTo(4), {
      progress: streamedProgress("run_str_1", "Looking at ", "the results"),
    });
    expect(view.rows).toEqual([
      firstMessage,
      { ...finishedRun, item: { ...finishedRun.item, finished: null } },
      {
        item: {
          kind: "message",
          role: "bot",
          id: "str-02",
          ts: at(2),
          ...ada,
          blocks: [{ kind: "steps", steps: [search, scoutCall("")] }],
        },
        ...alone,
      },
      {
        item: {
          kind: "subagent",
          status: "running",
          id: "subagent:str-04",
          ts: at(4),
          runId: "run_str_1",
          callId: "call_scout",
          name: "scout",
          task: "List competitors",
        },
        ...alone,
      },
      {
        item: {
          kind: "message",
          role: "bot",
          id: "progress:run_str_1",
          ts: at(5),
          ...ada,
          blocks: [{ kind: "progress", text: "Looking at the results" }],
          live: true,
        },
        ...alone,
      },
    ]);
    expect(view.waiting).toBeNull();
    expect(view.rowOf.get("str-04")).toBe("str-02");
  });

  it("shows the helper's card, the answered ask and the preview once the reply is in", () => {
    const view = projectThreadView(upTo(11));
    expect(view.rows).toEqual([
      firstMessage,
      finishedRun,
      answeredWork,
      scout,
      yes,
      {
        ...summary({
          kind: "link_preview",
          url: "https://acme.example",
          format: "compact",
          title: "Acme",
        }),
        previewMessageId: "str-09",
      },
    ]);
    expect(view.waiting).toBeNull();
    expect(["str-07", "str-10", "str-11"].map((id) => [id, view.rowOf.get(id)])).toEqual([
      ["str-07", "str-02"],
      ["str-10", "str-01"],
      ["str-11", "str-09"],
    ]);
  });

  it("cuts the edited turn at the rewind, marks it and drops the removed preview", () => {
    const view = projectThreadView([...streamed].reverse());
    expect(view.rows).toEqual([
      firstMessage,
      finishedRun,
      answeredWork,
      scout,
      yes,
      summary(),
      { item: { kind: "divider", id: "str-17", ts: at(17), reason: "rewind" }, ...alone },
      {
        item: {
          kind: "message",
          role: "user",
          id: "str-18",
          ts: at(18),
          blocks: text("And for Globex?"),
          clientNonce: "nonce-globex",
          source: "app",
        },
        ...alone,
        messageId: "str-18",
      },
    ]);
    expect(view.rowOf.get("str-12")).toBe("str-09");
    expect(view.rowOf.has("str-15")).toBe(false);
  });
});

describe("projectThreadView rewind", () => {
  const peer = { botId: "bot_bob", runId: "run_peer" };
  const peerFinished = {
    ...peer,
    type: "run.finished",
    payload: { status: "completed", usage: { inputTokens: 1, outputTokens: 1 } },
  };

  it("cuts the held turn after a parent the server held back, keeping what came before", () => {
    const [one, , two, , reply, rewind, edited] = linkEntries("hid", [
      { type: "user.message", payload: { blocks: text("One"), source: "app" } },
      peerFinished,
      { type: "user.message", payload: { blocks: text("Two"), source: "app" } },
      { ...peer, type: "assistant.text", payload: { blocks: text("Peer aside") } },
      { ...ada, type: "assistant.text", payload: { blocks: text("About two") } },
      { type: "rewind", parentId: "hid-1", payload: {} },
      { type: "user.message", payload: { blocks: text("Two edited"), source: "app" } },
    ]);
    const rows = projectThreadView([one!, two!, reply!, rewind!, edited!]).rows;
    expect(rows.map((row) => row.item.id)).toEqual(["hid-0", "hid-5", "hid-6"]);
  });

  it("keeps the turn before a rewind on a page read along the chain, its parent held back", () => {
    const [one, , rewind, edited] = linkEntries("chn", [
      { type: "user.message", payload: { blocks: text("One"), source: "app" } },
      peerFinished,
      { type: "rewind", payload: {} },
      { type: "user.message", payload: { blocks: text("Two edited"), source: "app" } },
    ]);
    const rows = projectThreadView([one!, rewind!, edited!]).rows;
    expect(rows.map((row) => row.item.id)).toEqual(["chn-0", "chn-2", "chn-3"]);
  });
});

describe("projectThreadView clear", () => {
  it("marks a clear written for an edited first message as an edit, a plain clear as a clear", () => {
    const [first, edit, edited, clear] = linkEntries("edt", [
      { type: "user.message", payload: { blocks: text("Hi"), source: "app" } },
      { type: "clear", parentId: null, payload: { edit: true } },
      { type: "user.message", payload: { blocks: text("Hello"), source: "app" } },
      { type: "clear", parentId: null, payload: {} },
    ]);
    expect(projectThreadView([first!, edit!, edited!]).rows.map((row) => row.item)).toEqual([
      { kind: "divider", id: "edt-1", ts: at(1), reason: "rewind" },
      expect.objectContaining({ id: "edt-2" }),
    ]);
    expect(projectThreadView([first!, edit!, edited!, clear!]).rows.map((row) => row.item)).toEqual(
      [{ kind: "divider", id: "edt-3", ts: at(3), reason: "clear" }],
    );
  });
});

describe("projectThreadView cards", () => {
  const run = { botId: "bot_ada", runId: "run_1" };
  const started = {
    ...run,
    type: "run.started",
    payload: { trigger: { kind: "direct" }, model, effort: null },
  };

  it("waits on an open ask, then shows the answer given in the card, absorbing its record", () => {
    const chain = linkEntries("ans", [
      started,
      { ...run, type: "assistant.ask", payload: { block: { kind: "ask", text: "Which day?" } } },
      { type: "card.answered", payload: { target: "ans-1", answer: "Tuesday" } },
      {
        type: "user.message",
        payload: { blocks: text("Tuesday"), replyTo: { entryId: "ans-1" }, source: "card" },
      },
    ]);
    expect(projectThreadView(chain.slice(0, 2)).waiting).toEqual({
      itemId: "ans-1",
      entryId: "ans-1",
      runId: "run_1",
    });
    const view = projectThreadView(chain);
    expect(view.rows.map((row) => row.item)).toEqual([
      expect.objectContaining({ kind: "run", id: "ans-0" }),
      {
        kind: "message",
        role: "bot",
        id: "ans-1",
        ts: at(1),
        ...run,
        blocks: [{ kind: "ask", text: "Which day?", status: "answered", answer: "Tuesday" }],
      },
    ]);
    expect(view.waiting).toBeNull();
    expect(["ans-2", "ans-3"].map((id) => view.rowOf.get(id))).toEqual(["ans-1", "ans-1"]);
    expect(projectThreadView(chain.slice(3)).rows).toEqual([]);
  });

  it("shows a multi-question card's answers given in the card", () => {
    const ask = {
      kind: "ask",
      text: "A few questions",
      questions: [
        {
          id: "city",
          question: "Which city should I start with?",
          options: [
            { id: "paris", label: "Paris" },
            { id: "lyon", label: "Lyon" },
          ],
        },
      ],
    };
    const answers = { city: { selected: ["paris"] } };
    const chain = linkEntries("multi", [
      started,
      { ...run, type: "assistant.ask", payload: { block: ask } },
      { type: "card.answered", payload: { target: "multi-1", answers } },
      {
        type: "user.message",
        payload: {
          blocks: text("1. Which city should I start with? — Paris"),
          replyTo: { entryId: "multi-1" },
          source: "card",
        },
      },
    ]);
    expect(projectThreadView(chain).rows.map((row) => row.item)).toEqual([
      expect.objectContaining({ kind: "run", id: "multi-0" }),
      {
        kind: "message",
        role: "bot",
        id: "multi-1",
        ts: at(1),
        ...run,
        blocks: [{ ...ask, status: "answered", answers }],
      },
    ]);
  });

  it("answers a secret ask with nothing and an onboarding choice with the option picked", () => {
    const chain = linkEntries("set", [
      started,
      {
        ...run,
        type: "assistant.ask",
        payload: { block: { kind: "ask", text: "Code", input: "secret" } },
      },
      { type: "card.answered", payload: { target: "set-1" } },
      {
        botId: "bot_ada",
        type: "bot.text",
        payload: {
          blocks: [
            {
              kind: "choice",
              question: "What first?",
              options: [
                { id: "inbox", letter: "A", label: "Clear my inbox" },
                { id: "week", letter: "B", label: "Plan my week" },
              ],
            },
          ],
        },
      },
      { type: "card.answered", payload: { target: "set-3", answerId: "week" } },
    ]);
    const blocks = projectThreadView(chain).rows.flatMap((row) =>
      row.item.kind === "message" ? row.item.blocks : [],
    );
    expect(blocks).toEqual([
      { kind: "ask", text: "Code", input: "secret", status: "answered", answer: "" },
      {
        kind: "choice",
        question: "What first?",
        options: [
          { id: "inbox", letter: "A", label: "Clear my inbox" },
          { id: "week", letter: "B", label: "Plan my week" },
        ],
        answerId: "week",
      },
    ]);
  });

  it("connects only the onboarding card whose connector and app the answer names", () => {
    const card = (provider: string) => ({
      kind: "app_connect",
      connectorId: "composio",
      provider,
      name: provider,
      description: "",
      logo: null,
      status: "pending",
    });
    const chain = linkEntries("con", [
      { botId: "bot_ada", type: "bot.text", payload: { blocks: [card("gmail"), card("slack")] } },
      { type: "card.answered", payload: { target: "con-0", answerId: "composio:slack" } },
    ]);
    const statuses = projectThreadView(chain).rows.flatMap((row) =>
      row.item.kind === "message"
        ? row.item.blocks.map((block) => block.kind === "app_connect" && block.status)
        : [],
    );
    expect(statuses).toEqual(["pending", "connected"]);
  });

  it("keeps a taught skill's newest draft revision", () => {
    const playbook = {
      whenToUse: "Mornings",
      inputs: [],
      steps: ["Read the news"],
      howToCheck: "Three items",
      whatToReturn: "A digest",
      approvalBoundaries: "None",
      failureHandling: "Say so",
    };
    const draft = { skillId: "skill_digest", goal: "Summarize the news", playbook };
    const chain = linkEntries("drf", [
      {
        botId: "bot_ada",
        type: "bot.text",
        payload: {
          blocks: [{ kind: "skill_draft", ...draft, name: "Digest", status: "draft" }],
        },
      },
      {
        type: "skill.draft",
        payload: { target: "drf-0", ...draft, name: "Morning digest", status: "draft" },
      },
      {
        type: "skill.draft",
        payload: { target: "drf-0", ...draft, name: "Morning digest", status: "saved" },
      },
    ]);
    const view = projectThreadView(chain);
    expect(view.rows.map((row) => row.item)).toEqual([
      {
        kind: "message",
        role: "bot",
        id: "drf-0",
        ts: at(0),
        botId: "bot_ada",
        blocks: [{ kind: "skill_draft", ...draft, name: "Morning digest", status: "saved" }],
      },
    ]);
    expect(view.rowOf.get("drf-2")).toBe("drf-0");
  });

  it("shows an approval's edit, the action tapped and the routine it created", () => {
    const card = {
      kind: "ask",
      text: "Create this routine?",
      approvalEffectId: "eff_1",
      actions: [
        { id: "allow", label: "Allow" },
        { id: "always", label: "Always allow" },
        { id: "deny", label: "Deny" },
      ],
      proposal: "routine",
      routine: { name: "Digest", schedule: "0 7 * * *", prompt: "News", notify: true },
    };
    const edited = { ...card, routine: { ...card.routine, name: "Morning digest" } };
    const chain = linkEntries("eff", [
      started,
      {
        ...run,
        type: "effect.requested",
        payload: {
          effectId: "eff_1",
          effectKind: "create_routine",
          proposal: { name: "Digest" },
          card,
        },
      },
      {
        ...run,
        type: "effect.edited",
        payload: { effectId: "eff_1", proposal: { name: "Morning digest" }, card: edited },
      },
      {
        ...run,
        type: "effect.resolved",
        payload: { effectId: "eff_1", decision: "approved", answerId: "always" },
      },
      {
        ...run,
        type: "effect.applied",
        payload: { target: "eff-1", routineId: "rtn_1", change: "created" },
      },
    ]);
    expect(projectThreadView(chain.slice(0, 3)).waiting).toEqual({
      itemId: "eff-1",
      entryId: "eff-1",
      runId: "run_1",
    });
    const view = projectThreadView(chain);
    expect(view.rows[1]).toEqual({
      item: {
        kind: "effect",
        id: "eff-1",
        ts: at(1),
        effectId: "eff_1",
        effectKind: "create_routine",
        proposal: { name: "Morning digest" },
        decision: "approved",
        ...run,
        card: {
          ...edited,
          status: "answered",
          answer: "always",
          created: { kind: "routine", id: "rtn_1", label: "Morning digest" },
          confirms: "created",
        },
      },
      ...alone,
      messageId: "eff-1",
    });
    expect(view.waiting).toBeNull();
  });
});

describe("projectThreadView rows", () => {
  it("folds emoji-only replies under their message, keeping one whose message is not held", () => {
    const reply = (target: string, value: string) => ({
      type: "user.message",
      payload: { blocks: text(value), replyTo: { entryId: target }, source: "app" },
    });
    const chain = linkEntries("rx", [
      { botId: "bot_ada", type: "bot.text", payload: { blocks: text("Shipped.") } },
      reply("rx-0", "👍"),
      reply("rx-0", "❤️"),
      reply("rx-0", "👍"),
      reply("gone", "🎉"),
    ]);
    const view = projectThreadView(chain);
    expect(view.rows.map((row) => [row.item.id, row.reactions])).toEqual([
      [
        "rx-0",
        [
          ["👍", 2],
          ["❤️", 1],
        ],
      ],
      ["rx-4", []],
    ]);
    expect(view.rowOf.get("rx-3")).toBe("rx-0");
  });

  it("groups narration of one bot and opens a group at a reply", () => {
    const chain = linkEntries("grp", [
      { botId: "bot_ada", type: "bot.text", payload: { blocks: text("One.") } },
      { botId: "bot_ada", type: "bot.text", payload: { blocks: text("Two.") } },
      { type: "user.message", payload: { blocks: text("Hi"), source: "app" } },
      {
        type: "user.message",
        payload: { blocks: text("About two"), replyTo: { entryId: "grp-1" }, source: "app" },
      },
    ]);
    expect(projectThreadView(chain).rows.map((row) => [row.firstOfGroup, row.lastOfGroup])).toEqual(
      [
        [true, false],
        [false, true],
        [true, true],
        [true, true],
      ],
    );
  });

  it("gives a row the message its preview entry targets, the row's own for an inline card", () => {
    const preview = {
      kind: "link_preview",
      url: "https://example.com/",
      format: "compact",
      title: "Example",
    };
    const bodies = [
      { ...ada, type: "assistant.text", payload: { blocks: text("Let me look.") } },
      { ...ada, type: "tool.call", payload: { callId: "c1", name: "web_fetch", input: "{}" } },
      {
        ...ada,
        type: "tool.result",
        payload: { callId: "c1", output: "ok", isError: false, artifactIds: [] },
      },
      { ...ada, type: "assistant.text", payload: { blocks: text("See https://example.com/") } },
      { type: "link.preview", payload: { target: "pv-3", block: preview } },
    ];
    const reply = (entries: SessionEntry[]) =>
      projectThreadView(entries).rows.find((row) => row.item.id === "pv-0");
    expect(reply(linkEntries("pv", bodies))).toMatchObject({
      messageId: "pv-0",
      previewMessageId: "pv-3",
    });
    const removal = { type: "link.preview.removed", payload: { target: "pv-4" } };
    expect(reply(linkEntries("pv", [...bodies, removal]))?.previewMessageId).toBeUndefined();

    const inline = linkEntries("in", [
      { botId: "bot_ada", type: "bot.text", payload: { blocks: [...text("Look"), preview] } },
    ]);
    expect(projectThreadView(inline).rows[0]?.previewMessageId).toBe("in-0");
  });

  it("folds quiet runs of one routine into a line and absorbs the message the newest sent", () => {
    const routine = (n: number) => [
      {
        botId: "bot_ada",
        runId: `run_r${n}`,
        type: "routine.started",
        payload: {
          sessionId: `ses_r${n}`,
          routineId: "rtn_digest",
          name: "Digest",
          trigger: "routine",
          scheduledAt: at(0),
          model,
        },
      },
      {
        botId: "bot_ada",
        runId: `run_r${n}`,
        type: "routine.finished",
        payload: {
          status: "completed",
          usage: { inputTokens: 1, outputTokens: 1 },
          result: "Done",
        },
      },
    ];
    const chain = linkEntries("rtn", [
      ...routine(1),
      ...routine(2),
      ...routine(3),
      {
        botId: "bot_ada",
        type: "bot.message.sent",
        payload: {
          originSessionId: "ses_r3",
          to: { kind: "bot", botId: "bot_bea", name: "Bea" },
          text: "Digest ready",
          intent: "result",
          hop: 1,
          exchangeId: "rtn-6",
        },
      },
    ]);
    const item = (n: number) => ({
      kind: "routine",
      id: `rtn-${(n - 1) * 2}`,
      ts: at((n - 1) * 2),
      runId: `run_r${n}`,
      botId: "bot_ada",
      sessionId: `ses_r${n}`,
      routineId: "rtn_digest",
      name: "Digest",
      finished: { status: "completed", result: "Done" },
    });
    const view = projectThreadView(chain);
    expect(view.rows).toEqual([
      {
        item: item(2),
        ...alone,
        routine: {
          kind: "group",
          runs: [
            { item: item(1), latest: false },
            { item: item(2), latest: false },
          ],
        },
        marker: { at: at(0), withTime: false },
      },
      {
        item: item(3),
        ...alone,
        routine: {
          kind: "run",
          run: {
            item: item(3),
            latest: true,
            sentTo: {
              kind: "botMessage",
              direction: "sent",
              id: "rtn-6",
              ts: at(6),
              botId: "bot_ada",
              peer: { kind: "bot", botId: "bot_bea", name: "Bea" },
              text: "Digest ready",
              intent: "result",
              exchangeId: "rtn-6",
              answeredBy: null,
              origin: { sessionId: "ses_r3", kind: "routine", name: "Digest" },
            },
          },
        },
      },
    ]);
    expect(["rtn-0", "rtn-6"].map((id) => view.rowOf.get(id))).toEqual(["rtn-2", "rtn-4"]);
  });
});

describe("visibleEntries", () => {
  const peer = { botId: "bot_sub", runId: "run_peer" };
  const chain = linkEntries("vis", [
    { type: "user.message", payload: { blocks: text("Ask the team"), source: "app" } },
    { ...peer, type: "run.started", payload: { trigger: { kind: "direct" }, model, effort: null } },
    { ...peer, type: "tool.call", payload: { callId: "c1", name: "search", input: "{}" } },
    { ...peer, type: "assistant.text", payload: { blocks: text("Working on it") } },
    { ...peer, type: "assistant.text", payload: { blocks: text("Found it"), toPerson: true } },
    { ...peer, type: "assistant.ask", payload: { block: { kind: "ask", text: "Which?" } } },
    { type: "card.answered", ...peer, payload: { target: "vis-5", answerId: "first" } },
  ]);

  it("keeps a hidden peer run's words to the person, its cards and their answers", () => {
    const ids = (entries: SessionEntry[]) => entries.map((entry) => entry.id);
    const hiddenPeerRunIds = new Set(["run_peer"]);
    expect(ids(visibleEntries(chain, { hiddenPeerRunIds }))).toEqual([
      "vis-0",
      "vis-4",
      "vis-5",
      "vis-6",
    ]);
  });
});

describe("the entry feed", () => {
  const chain = linkEntries("feed", [
    { type: "user.message", payload: { blocks: text("Hello"), source: "app" } },
    {
      botId: "bot_ada",
      runId: "run_1",
      type: "assistant.text",
      payload: { blocks: text("Hello there.") },
    },
  ]);

  it("clears a run's streamed text when its entry lands, so the text shows once", () => {
    const streaming = streamedProgress("run_1", "Hello there.");
    const appended = event("session.entry.appended", { entries: [chain[1]] }, "run_1");
    const layer = reduceProgressLayer(streaming, appended);
    expect([...layer.keys()]).toEqual([]);
    const held = mergeEntries(chain.slice(0, 1), appendedEntries(appended));
    expect(
      projectThreadView(held, { progress: layer }).rows.flatMap((row) =>
        row.item.kind === "message" ? row.item.blocks : [],
      ),
    ).toEqual([
      { kind: "text", text: "Hello" },
      { kind: "text", text: "Hello there." },
    ]);
    expect(reduceProgressLayer(streaming, event("run.completed", {}, "run_1")).size).toBe(0);
    expect(reduceProgressLayer(streaming, event("thread.meta", {}))).toBe(streaming);
  });

  it("merges a replayed event and an overlapping page without adding an entry twice", () => {
    const ids = (entries: SessionEntry[]) => entries.map((entry) => entry.id);
    const merged = mergeEntries([chain[1]!], chain);
    expect(ids(merged)).toEqual(["feed-0", "feed-1"]);
    expect(ids(mergeEntries(merged, [chain[1]!]))).toEqual(["feed-0", "feed-1"]);
    expect(appendedEntries(event("session.entry.appended", { entries: [{ id: "x" }] }))).toEqual(
      [],
    );
  });
});

describe("the entries a client holds", () => {
  const said = linkEntries(
    "held",
    ["Zero", "One", "Two", "Three"].map((words) => ({
      type: "user.message",
      payload: { blocks: text(words), source: "app" },
    })),
  );
  const held = (entries: SessionEntry[], olderCursor: string | null): ThreadEntries => ({
    entries,
    olderCursor: olderCursor as ThreadEntries["olderCursor"],
    cursor: 3,
    layer: new Map(),
  });
  const ids = (state: ThreadEntries) => state.entries.map((entry) => entry.id);
  const at = (seq: number, type: string, payload: Record<string, unknown>, runId?: string) => ({
    ...event(type, payload, runId),
    seq,
  });

  it("merges an appended entry by seq and ignores the same event replayed", () => {
    const appended = at(5, "session.entry.appended", { entries: [said[1]] });
    const next = applyEntryEvent(held([said[0]!, said[2]!], null), appended);
    expect(ids(next)).toEqual(["held-0", "held-1", "held-2"]);
    expect(next.cursor).toBe(5);
    expect(applyEntryEvent(next, appended)).toBe(next);
  });

  it("streams a run's text, ignores a delta replayed and clears it when the entry lands", () => {
    const delta = at(4, "thread.progress", { delta: "Hel" }, "run_1");
    const streaming = applyEntryEvent(applyEntryEvent(held([], null), delta), delta);
    expect(streaming.layer.get("run_1")?.blocks).toEqual([{ kind: "progress", text: "Hel" }]);
    const reply = { ...said[0]!, botId: "bot_ada", runId: "run_1" };
    const settled = applyEntryEvent(
      streaming,
      at(5, "session.entry.appended", { entries: [reply] }, "run_1"),
    );
    expect([...settled.layer.keys()]).toEqual([]);
  });

  it("seeds the layer from the progress a snapshot replays", () => {
    const seeded = threadEntriesOf({
      threadId: "thread_1",
      progress: [at(2, "thread.progress", { delta: "Hel" }, "run_1")],
    });
    expect(seeded.threadId).toBe("thread_1");
    expect([...seeded.layer.keys()]).toEqual(["run_1"]);
  });

  it("merges an older page before the held entries and moves the history cursor", () => {
    const page = { entries: [said[0]!, said[1]!, said[2]!], olderCursor: null };
    const next = withOlderEntries(held([said[2]!, said[3]!], "held-2"), page);
    expect(ids(next)).toEqual(["held-0", "held-1", "held-2", "held-3"]);
    expect(next.olderCursor).toBeNull();
    const cleared = held([], null);
    expect(withOlderEntries(cleared, page)).toBe(cleared);
  });

  it("keeps loaded history older than a refreshed page and the older cursor", () => {
    const stale = { ...said[2]!, payload: { blocks: text("Stale two"), source: "app" } };
    const previous = held([said[0]!, said[1]!, stale as SessionEntry], null);
    const recent = held([said[2]!, said[3]!], "held-2");

    const kept = withRefreshedEntries(previous, recent, true);
    expect(kept.entries).toEqual([said[0], said[1], said[2], said[3]]);
    expect(kept.olderCursor).toBeNull();
    expect(withRefreshedEntries(previous, recent, false)).toBe(recent);
  });

  it("drops a jump window the refreshed page does not connect to", () => {
    const jumped = held([said[0]!, said[1]!].map(detached(10)), "held-10");
    const recent = held([said[2]!, said[3]!].map(detached(20)), "held-20");
    expect(withRefreshedEntries(jumped, recent, true)).toBe(recent);
  });
});

function detached(by: number) {
  return (entry: SessionEntry): SessionEntry =>
    SessionEntrySchema.parse({
      ...entry,
      id: `held-${entry.seq + by}`,
      seq: entry.seq + by,
      parentId: `held-${entry.seq + by - 1}`,
    });
}
