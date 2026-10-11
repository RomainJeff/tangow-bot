import { describe, expect, it } from "vitest";
import { fixtureChain, linkEntries } from "./fixtures/read-fixture.js";
import { projectThreadItems } from "./project-ui.js";

const model = { provider: "emulator", id: "emulator-1" };
const at = (second: number) => `2026-10-10T09:00:${String(second).padStart(2, "0")}.000Z`;
const text = (value: string) => [{ kind: "text", text: value }];

describe("projectThreadItems", () => {
  it("folds a linear chain into messages, runs, an approval and a note, including a cancelled run", async () => {
    expect(projectThreadItems(await fixtureChain("linear"))).toEqual([
      {
        kind: "message",
        role: "user",
        id: "lin-00",
        ts: at(0),
        blocks: text("Email Lyon's weather to the team."),
        source: "app",
      },
      {
        kind: "note",
        id: "lin-01",
        ts: at(1),
        type: "session.title",
        payload: { title: "Lyon weather email" },
      },
      {
        kind: "run",
        id: "lin-02",
        ts: at(2),
        runId: "run_lin_1",
        botId: "bot_ada",
        trigger: { kind: "message", entryId: "lin-00" },
        model,
        effort: "medium",
        finished: {
          outcome: { status: "completed", usage: { inputTokens: 1200, outputTokens: 40 } },
          durationMs: 9000,
        },
      },
      {
        kind: "message",
        role: "bot",
        id: "lin-03",
        ts: at(3),
        botId: "bot_ada",
        runId: "run_lin_1",
        blocks: [
          { kind: "reasoning", text: "The user wants the weather first." },
          { kind: "text", text: "Let me check." },
          {
            kind: "steps",
            durationMs: 9000,
            steps: [
              {
                label: "Get weather",
                count: 1,
                calls: [
                  {
                    name: "get_weather",
                    input: '{"city":"Lyon"}',
                    output: "18°C, sunny",
                    id: "call_weather",
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        kind: "effect",
        id: "lin-07",
        ts: at(7),
        effectId: "eff_mail",
        effectKind: "send_email",
        proposal: { to: "ops@example.com", subject: "Lyon weather" },
        decision: "approved",
        botId: "bot_ada",
        runId: "run_lin_1",
      },
      {
        kind: "message",
        role: "bot",
        id: "lin-10",
        ts: at(10),
        botId: "bot_ada",
        runId: "run_lin_1",
        blocks: text("Sent: it is 18°C and sunny in Lyon."),
      },
      {
        kind: "message",
        role: "user",
        id: "lin-12",
        ts: at(12),
        blocks: text("And tomorrow?"),
        replyTo: { entryId: "lin-03" },
        clientNonce: "nonce-tomorrow",
        source: "app",
      },
      {
        kind: "run",
        id: "lin-13",
        ts: at(13),
        runId: "run_lin_2",
        botId: "bot_ada",
        trigger: { kind: "message", entryId: "lin-12" },
        model,
        effort: "medium",
        finished: {
          outcome: {
            status: "cancelled",
            usage: { inputTokens: 1300, outputTokens: 3 },
            by: "user_1",
          },
          durationMs: 2000,
        },
      },
      {
        kind: "message",
        role: "bot",
        id: "lin-14",
        ts: at(14),
        botId: "bot_ada",
        runId: "run_lin_2",
        blocks: text("Tomorrow looks"),
      },
    ]);
  });

  it("splits a run's message around a steering message written while it ran", async () => {
    expect(projectThreadItems(await fixtureChain("steered"))).toEqual([
      {
        kind: "message",
        role: "user",
        id: "st-00",
        ts: at(0),
        blocks: text("Write a haiku about Lyon."),
        source: "app",
      },
      {
        kind: "run",
        id: "st-01",
        ts: at(1),
        runId: "run_st_1",
        botId: "bot_ada",
        trigger: { kind: "message", entryId: "st-00" },
        model,
        effort: null,
        finished: {
          outcome: { status: "completed", usage: { inputTokens: 300, outputTokens: 12 } },
          durationMs: 4000,
        },
      },
      {
        kind: "message",
        role: "bot",
        id: "st-02",
        ts: at(2),
        botId: "bot_ada",
        runId: "run_st_1",
        blocks: text("Two rivers at dusk."),
      },
      {
        kind: "message",
        role: "user",
        id: "st-03",
        ts: at(3),
        blocks: text("Make it about rain."),
        source: "steering",
      },
      {
        kind: "message",
        role: "bot",
        id: "st-04",
        ts: at(4),
        botId: "bot_ada",
        runId: "run_st_1",
        blocks: text("Rain on Fourvière."),
      },
    ]);
  });

  it("keeps one message per run when two runs interleave with nothing between them", async () => {
    expect(projectThreadItems(await fixtureChain("interleaved"))).toEqual([
      {
        kind: "message",
        role: "bot",
        id: "itl-00",
        ts: at(0),
        botId: "bot_ada",
        runId: "run_itl_a",
        blocks: text("Checking the calendar."),
      },
      {
        kind: "message",
        role: "bot",
        id: "itl-01",
        ts: at(1),
        botId: "bot_bob",
        runId: "run_itl_b",
        blocks: [
          {
            kind: "steps",
            steps: [
              {
                label: "Search flights",
                count: 1,
                calls: [
                  {
                    name: "search_flights",
                    input: '{"to":"Lyon"}',
                    output: "",
                    id: "call_flights",
                  },
                ],
              },
            ],
          },
          { kind: "text", text: "Two flights found." },
          { kind: "text", text: "The 9:00 one is cheaper." },
        ],
      },
    ]);
  });

  it("marks the rewind with a divider and keeps only what the chain still holds", async () => {
    expect(projectThreadItems(await fixtureChain("rewound"))).toEqual([
      {
        kind: "message",
        role: "user",
        id: "rew-00",
        ts: at(0),
        blocks: text("Summarize the report."),
        source: "app",
      },
      {
        kind: "run",
        id: "rew-01",
        ts: at(1),
        runId: "run_rew_1",
        botId: "bot_ada",
        trigger: { kind: "message", entryId: "rew-00" },
        model,
        effort: null,
        finished: {
          outcome: { status: "completed", usage: { inputTokens: 800, outputTokens: 12 } },
          durationMs: 2000,
        },
      },
      {
        kind: "message",
        role: "bot",
        id: "rew-02",
        ts: at(2),
        botId: "bot_ada",
        runId: "run_rew_1",
        blocks: text("Revenue grew this quarter."),
      },
      {
        kind: "message",
        role: "user",
        id: "rew-04",
        ts: at(4),
        blocks: text("Now chart it."),
        source: "app",
      },
      {
        kind: "run",
        id: "rew-05",
        ts: at(5),
        runId: "run_rew_2",
        botId: "bot_ada",
        trigger: { kind: "message", entryId: "rew-04" },
        model,
        effort: null,
        finished: null,
      },
      {
        kind: "message",
        role: "bot",
        id: "rew-06",
        ts: at(6),
        botId: "bot_ada",
        runId: "run_rew_2",
        blocks: [
          {
            kind: "steps",
            steps: [
              {
                label: "Render plot",
                count: 1,
                calls: [
                  {
                    name: "render_plot",
                    input: '{"x":"quarter","y":"revenue"}',
                    output: "",
                    id: "call_chart",
                  },
                ],
              },
            ],
          },
        ],
      },
      { kind: "divider", id: "rew-10", ts: at(10), reason: "rewind" },
      {
        kind: "run",
        id: "rew-11",
        ts: at(11),
        runId: "run_rew_3",
        botId: "bot_ada",
        trigger: {
          kind: "retry",
          attempt: 2,
          previousRunId: "run_rew_2",
          reason: "The chart used the wrong axis.",
        },
        model,
        effort: null,
        finished: {
          outcome: { status: "completed", usage: { inputTokens: 950, outputTokens: 20 } },
          durationMs: 2000,
        },
      },
      {
        kind: "message",
        role: "bot",
        id: "rew-12",
        ts: at(12),
        botId: "bot_ada",
        runId: "run_rew_3",
        blocks: text("Revenue by quarter: 1.0M, 1.1M, 1.2M."),
      },
    ]);
  });

  it("folds a routine run's two tool calls into one steps block after the compaction divider", async () => {
    const page = (await fixtureChain("compacted")).filter((entry) => entry.seq >= 10);
    expect(projectThreadItems(page)).toEqual([
      { kind: "divider", id: "cmp-10", ts: at(10), reason: "compaction" },
      {
        kind: "run",
        id: "cmp-11",
        ts: at(11),
        runId: "run_cmp_3",
        botId: "bot_ada",
        trigger: {
          kind: "routine",
          routineId: "rtn_digest",
          name: "Morning digest",
          scheduledAt: "2026-10-10T07:00:00.000Z",
        },
        model,
        effort: null,
        finished: {
          outcome: { status: "completed", usage: { inputTokens: 700, outputTokens: 30 } },
          durationMs: 6000,
        },
      },
      {
        kind: "message",
        role: "bot",
        id: "cmp-12",
        ts: at(12),
        botId: "bot_ada",
        runId: "run_cmp_3",
        blocks: [
          {
            kind: "steps",
            durationMs: 6000,
            steps: [
              {
                label: "Fetch news",
                count: 1,
                calls: [
                  {
                    name: "fetch_news",
                    input: '{"topic":"launch"}',
                    output: "3 articles",
                    id: "call_news",
                  },
                ],
              },
              {
                label: "Send email",
                count: 1,
                calls: [
                  { name: "send_email", input: '{"to":"team"}', output: "sent", id: "call_mail" },
                ],
              },
            ],
          },
          { kind: "text", text: "Digest sent: 3 articles about the launch." },
        ],
      },
    ]);
  });

  it("places the compaction divider above the window of turns it kept word for word", async () => {
    const items = projectThreadItems(await fixtureChain("compacted"));
    expect(items.map((item) => [item.kind, item.id])).toEqual([
      ["divider", "cmp-10"],
      ["message", "cmp-04"],
      ["run", "cmp-05"],
      ["message", "cmp-06"],
      ["run", "cmp-11"],
      ["message", "cmp-12"],
    ]);
  });

  it("folds a routine's start and finish into one item at its start, open until it finishes", () => {
    const started = (runId: string, name: string) => ({
      botId: "bot_ada",
      runId,
      type: "routine.started",
      payload: {
        sessionId: `ses_${runId}`,
        routineId: `rtn_${runId}`,
        name,
        trigger: "routine",
        scheduledAt: at(0),
        model,
      },
    });
    const finished = (runId: string, payload: object) => ({
      botId: "bot_ada",
      runId,
      type: "routine.finished",
      payload: { usage: { inputTokens: 300, outputTokens: 9 }, ...payload },
    });
    const chain = linkEntries("rtn", [
      finished("run_before_page", { status: "completed", result: "Older." }),
      started("run_brief", "Morning brief"),
      started("run_digest", "Digest"),
      finished("run_brief", { status: "completed", result: "Two meetings today." }),
    ]);
    expect(projectThreadItems(chain)).toEqual([
      {
        kind: "routine",
        id: "rtn-1",
        ts: at(1),
        runId: "run_brief",
        botId: "bot_ada",
        sessionId: "ses_run_brief",
        routineId: "rtn_run_brief",
        name: "Morning brief",
        finished: { status: "completed", result: "Two meetings today." },
      },
      {
        kind: "routine",
        id: "rtn-2",
        ts: at(2),
        runId: "run_digest",
        botId: "bot_ada",
        sessionId: "ses_run_digest",
        routineId: "rtn_run_digest",
        name: "Digest",
        finished: null,
      },
    ]);
  });

  it("names the routine or the helper a risen entry came from when the page holds its start", () => {
    const approval = {
      kind: "mcp_approval",
      name: "Press",
      serverId: "mcp_press",
      transport: "streamable_http",
      endpoint: null,
      needsOAuth: true,
    };
    const veille = { originSessionId: "ses_veille" };
    const chain = linkEntries("org", [
      {
        botId: "bot_ada",
        runId: "run_veille",
        type: "routine.started",
        payload: {
          sessionId: "ses_veille",
          routineId: "rtn_veille",
          name: "Veille presse",
          trigger: "routine",
          scheduledAt: at(0),
          model,
        },
      },
      {
        botId: "bot_ada",
        runId: "run_veille",
        type: "assistant.ask",
        payload: { ...veille, block: { kind: "ask", text: "Which outlets?" } },
      },
      {
        type: "user.message",
        payload: {
          ...veille,
          blocks: text("Le Monde"),
          replyTo: { entryId: "org-1" },
          clientNonce: "nonce-le-monde",
          source: "app",
        },
      },
      {
        botId: "bot_ada",
        runId: "run_veille",
        type: "assistant.text",
        payload: { ...veille, blocks: [approval] },
      },
      { type: "user.message", payload: { blocks: text("Thanks."), source: "app" } },
      {
        botId: "bot_ada",
        runId: "run_scout",
        type: "effect.requested",
        payload: {
          originSessionId: "ses_scout",
          effectId: "effect_1",
          effectKind: "spawn_bot",
          proposal: { name: "Scout" },
        },
      },
      {
        botId: "bot_ada",
        runId: "run_main",
        type: "subagent",
        payload: {
          callId: "call_scout",
          sessionId: "ses_scout",
          name: "scout",
          model,
          task: "Find a press bot",
          status: "completed",
          result: "Asked for Scout.",
          usage: { inputTokens: 10, outputTokens: 2 },
        },
      },
      {
        botId: "bot_ada",
        type: "skill.learnt",
        payload: {
          originSessionId: "ses_gone",
          skillId: "user:digest",
          name: "Digest",
          change: "learned",
        },
      },
    ]);
    const fromVeille = { sessionId: "ses_veille", kind: "routine", name: "Veille presse" };

    expect(projectThreadItems(chain)).toEqual([
      {
        kind: "routine",
        id: "org-0",
        ts: at(0),
        runId: "run_veille",
        botId: "bot_ada",
        sessionId: "ses_veille",
        routineId: "rtn_veille",
        name: "Veille presse",
        finished: null,
      },
      {
        kind: "message",
        role: "bot",
        id: "org-1",
        ts: at(1),
        botId: "bot_ada",
        runId: "run_veille",
        blocks: [{ kind: "ask", text: "Which outlets?", status: "answered", answer: "Le Monde" }],
        origin: fromVeille,
      },
      {
        kind: "message",
        role: "user",
        id: "org-2",
        ts: at(2),
        blocks: text("Le Monde"),
        replyTo: { entryId: "org-1" },
        clientNonce: "nonce-le-monde",
        source: "app",
        origin: fromVeille,
      },
      {
        kind: "message",
        role: "bot",
        id: "org-3",
        ts: at(3),
        botId: "bot_ada",
        runId: "run_veille",
        blocks: [approval],
        origin: fromVeille,
      },
      {
        kind: "message",
        role: "user",
        id: "org-4",
        ts: at(4),
        blocks: text("Thanks."),
        source: "app",
      },
      {
        kind: "effect",
        id: "org-5",
        ts: at(5),
        effectId: "effect_1",
        effectKind: "spawn_bot",
        proposal: { name: "Scout" },
        decision: null,
        botId: "bot_ada",
        runId: "run_scout",
        origin: { sessionId: "ses_scout", kind: "subagent", name: "scout" },
      },
      {
        kind: "subagent",
        id: "org-6",
        ts: at(6),
        runId: "run_main",
        callId: "call_scout",
        sessionId: "ses_scout",
        name: "scout",
        model,
        task: "Find a press bot",
        status: "completed",
        result: "Asked for Scout.",
        usage: { inputTokens: 10, outputTokens: 2 },
      },
      {
        kind: "note",
        id: "org-7",
        ts: at(7),
        type: "skill.learnt",
        payload: {
          originSessionId: "ses_gone",
          skillId: "user:digest",
          name: "Digest",
          change: "learned",
        },
        origin: { sessionId: "ses_gone" },
      },
    ]);
  });

  it("gives a subagent its own item that points at the child session", async () => {
    expect(projectThreadItems(await fixtureChain("subagent"))).toEqual([
      {
        kind: "message",
        role: "user",
        id: "sub-00",
        ts: at(0),
        blocks: text("Find three competitors."),
        source: "app",
      },
      {
        kind: "run",
        id: "sub-01",
        ts: at(1),
        runId: "run_sub_1",
        botId: "bot_ada",
        trigger: { kind: "message", entryId: "sub-00" },
        model,
        effort: "high",
        finished: {
          outcome: { status: "completed", usage: { inputTokens: 1500, outputTokens: 60 } },
          durationMs: 4000,
        },
      },
      {
        kind: "message",
        role: "bot",
        id: "sub-02",
        ts: at(2),
        botId: "bot_ada",
        runId: "run_sub_1",
        blocks: [
          {
            kind: "steps",
            durationMs: 4000,
            steps: [
              {
                label: "Run subagent",
                count: 1,
                calls: [
                  {
                    name: "run_subagent",
                    input: '{"name":"researcher","task":"List three competitors"}',
                    output: "Acme, Globex, Initech",
                    id: "call_helper",
                  },
                ],
              },
            ],
          },
          { kind: "text", text: "Your competitors are Acme, Globex and Initech." },
        ],
      },
      {
        kind: "subagent",
        id: "sub-03",
        ts: at(3),
        runId: "run_sub_1",
        callId: "call_helper",
        sessionId: "ses_helper",
        name: "researcher",
        model,
        task: "List three competitors",
        status: "completed",
        result: "Acme, Globex, Initech",
        usage: { inputTokens: 400, outputTokens: 25 },
      },
    ]);
  });

  it("shows a group handoff, the receiver's handoff-triggered run and an unanswered message", async () => {
    expect(projectThreadItems(await fixtureChain("group"))).toEqual([
      {
        kind: "message",
        role: "user",
        id: "grp-00",
        ts: at(0),
        blocks: text("Ada, plan the launch post, then hand it to Bob."),
        source: "app",
      },
      {
        kind: "run",
        id: "grp-01",
        ts: at(1),
        runId: "run_grp_1",
        botId: "bot_ada",
        trigger: { kind: "message", entryId: "grp-00" },
        model,
        effort: null,
        finished: {
          outcome: { status: "completed", usage: { inputTokens: 600, outputTokens: 10 } },
          durationMs: 3000,
        },
      },
      {
        kind: "message",
        role: "bot",
        id: "grp-02",
        ts: at(2),
        botId: "bot_ada",
        runId: "run_grp_1",
        blocks: text("Plan: announce Tuesday."),
      },
      {
        kind: "handoff",
        id: "grp-03",
        ts: at(3),
        fromBotId: "bot_ada",
        toBotId: "bot_bob",
        text: "Write the post.",
      },
      {
        kind: "run",
        id: "grp-05",
        ts: at(5),
        runId: "run_grp_2",
        botId: "bot_bob",
        trigger: { kind: "handoff", entryId: "grp-03" },
        model,
        effort: null,
        finished: {
          outcome: { status: "completed", usage: { inputTokens: 650, outputTokens: 14 } },
          durationMs: 3000,
        },
      },
      {
        kind: "message",
        role: "bot",
        id: "grp-06",
        ts: at(6),
        botId: "bot_bob",
        runId: "run_grp_2",
        blocks: text("Draft: we launch Tuesday."),
      },
      {
        kind: "botMessage",
        direction: "sent",
        id: "grp-07",
        ts: at(7),
        botId: "bot_bob",
        peer: { kind: "bot", botId: "bot_cy", name: "Cy" },
        text: "Can you translate the draft?",
        intent: "request",
        exchangeId: "grp-07",
        answeredBy: null,
      },
    ]);
  });

  it("links a sent bot message to the reply that answered it", async () => {
    expect(projectThreadItems(await fixtureChain("bot-exchange"))).toEqual([
      {
        kind: "message",
        role: "user",
        id: "bx-00",
        ts: at(0),
        blocks: text("Ask Bob for the Q3 revenue."),
        source: "app",
      },
      {
        kind: "run",
        id: "bx-01",
        ts: at(1),
        runId: "run_bx_1",
        botId: "bot_ada",
        trigger: { kind: "message", entryId: "bx-00" },
        model,
        effort: null,
        finished: {
          outcome: { status: "completed", usage: { inputTokens: 700, outputTokens: 9 } },
          durationMs: 5000,
        },
      },
      {
        kind: "message",
        role: "bot",
        id: "bx-02",
        ts: at(2),
        botId: "bot_ada",
        runId: "run_bx_1",
        blocks: [
          {
            kind: "steps",
            durationMs: 5000,
            steps: [
              {
                label: "Message bot",
                count: 1,
                calls: [
                  {
                    name: "message_bot",
                    input: '{"bot_id":"bot_bob","message":"What was Q3 revenue?"}',
                    output: "Sent to Bob.",
                    id: "call_ask_bob",
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        kind: "botMessage",
        direction: "sent",
        id: "bx-03",
        ts: at(3),
        botId: "bot_ada",
        peer: { kind: "bot", botId: "bot_bob", name: "Bob" },
        text: "What was Q3 revenue?",
        intent: "request",
        exchangeId: "bx-03",
        answeredBy: "bx-07",
      },
      {
        kind: "message",
        role: "bot",
        id: "bx-05",
        ts: at(5),
        botId: "bot_ada",
        runId: "run_bx_1",
        blocks: text("I asked Bob."),
      },
      {
        kind: "botMessage",
        direction: "received",
        id: "bx-07",
        ts: at(7),
        peer: { kind: "bot", botId: "bot_bob", name: "Bob" },
        text: "Q3 revenue was 1.2M.",
        intent: "result",
        exchangeId: "bx-03",
        origin: { sessionId: "ses_bob", entryId: "bob-12" },
      },
      {
        kind: "run",
        id: "bx-08",
        ts: at(8),
        runId: "run_bx_2",
        botId: "bot_ada",
        trigger: { kind: "bot_message", entryId: "bx-07" },
        model,
        effort: null,
        finished: {
          outcome: { status: "completed", usage: { inputTokens: 760, outputTokens: 11 } },
          durationMs: 2000,
        },
      },
      {
        kind: "message",
        role: "bot",
        id: "bx-09",
        ts: at(9),
        botId: "bot_ada",
        runId: "run_bx_2",
        blocks: text("Bob says Q3 revenue was 1.2M."),
      },
    ]);
  });

  it("opens on the clear divider and shows an ask and a choice answered by their answer records", async () => {
    expect(projectThreadItems(await fixtureChain("cleared"))).toEqual([
      { kind: "divider", id: "clr-01", ts: at(1), reason: "clear" },
      {
        kind: "message",
        role: "user",
        id: "clr-02",
        ts: at(2),
        blocks: [
          { kind: "text", text: "Draft the launch post from these." },
          { kind: "image", artifactId: "art_photo", mimeType: "image/png", name: "site.png" },
          {
            kind: "file",
            artifactId: "art_brief",
            mimeType: "application/pdf",
            name: "brief.pdf",
            size: 2048,
          },
          {
            kind: "link_preview",
            url: "https://example.com/launch",
            format: "compact",
            title: "Launch page",
          },
        ],
        source: "app",
      },
      {
        kind: "run",
        id: "clr-03",
        ts: at(3),
        runId: "run_clr_1",
        botId: "bot_ada",
        trigger: { kind: "message", entryId: "clr-02" },
        model,
        effort: null,
        finished: {
          outcome: { status: "completed", usage: { inputTokens: 800, outputTokens: 9 } },
          durationMs: 2000,
        },
      },
      {
        kind: "message",
        role: "bot",
        id: "clr-04",
        ts: at(4),
        botId: "bot_ada",
        runId: "run_clr_1",
        blocks: [
          {
            kind: "ask",
            text: "Which day should it go out?",
            status: "answered",
            answer: "Tuesday.",
          },
        ],
      },
      {
        kind: "note",
        id: "clr-07",
        ts: at(7),
        type: "computer.control",
        payload: { holder: "user" },
      },
      {
        kind: "run",
        id: "clr-08",
        ts: at(8),
        runId: "run_clr_2",
        botId: "bot_ada",
        trigger: { kind: "webhook", routineId: "rtn_launch" },
        model,
        effort: null,
        finished: {
          outcome: { status: "completed", usage: { inputTokens: 850, outputTokens: 14 } },
          durationMs: 2000,
        },
      },
      {
        kind: "message",
        role: "bot",
        id: "clr-09",
        ts: at(9),
        botId: "bot_ada",
        runId: "run_clr_2",
        blocks: [
          {
            kind: "choice",
            question: "Publish the post now?",
            options: [
              { id: "now", letter: "A", label: "Publish now" },
              { id: "later", letter: "B", label: "Wait for Tuesday" },
            ],
          },
        ],
      },
      {
        kind: "message",
        role: "bot",
        id: "clr-11",
        ts: at(11),
        botId: "bot_ada",
        blocks: [
          {
            kind: "choice",
            question: "What should I work on next?",
            options: [
              { id: "inbox", letter: "A", label: "Clear my inbox" },
              { id: "week", letter: "B", label: "Plan my week" },
            ],
            answerId: "Plan my week.",
          },
        ],
      },
    ]);
  });

  it("shows a bot's words outside a run as their own message, splitting a run's stretch", () => {
    const run = { botId: "bot_ada", runId: "run_1" };
    const chain = linkEntries("aside", [
      { ...run, type: "assistant.text", payload: { blocks: text("Recording your steps.") } },
      { botId: "bot_ada", type: "bot.text", payload: { blocks: text("Draft skill saved.") } },
      { ...run, type: "assistant.text", payload: { blocks: text("Back to the export.") } },
    ]);
    expect(projectThreadItems(chain)).toEqual([
      {
        kind: "message",
        role: "bot",
        id: "aside-0",
        ts: at(0),
        ...run,
        blocks: text("Recording your steps."),
      },
      {
        kind: "message",
        role: "bot",
        id: "aside-1",
        ts: at(1),
        botId: "bot_ada",
        blocks: text("Draft skill saved."),
      },
      {
        kind: "message",
        role: "bot",
        id: "aside-2",
        ts: at(2),
        ...run,
        blocks: text("Back to the export."),
      },
    ]);
  });

  describe("a call id the provider reused", () => {
    const run = { botId: "bot_ada", runId: "run_1" };
    const call = (path: string) => ({
      ...run,
      type: "tool.call",
      payload: { callId: "call_0", name: "read_file", input: JSON.stringify({ path }) },
    });
    const result = (output: string) => ({
      ...run,
      type: "tool.result",
      payload: { callId: "call_0", output, isError: false, artifactIds: [] },
    });
    const shown = (path: string, output: string) => ({
      name: "read_file",
      input: JSON.stringify({ path }),
      output,
      id: "call_0",
    });
    const readFiles = (id: string, calls: ReturnType<typeof shown>[]) => ({
      kind: "message",
      role: "bot",
      id,
      ts: at(Number(id.split("-")[1])),
      ...run,
      blocks: [{ kind: "steps", steps: [{ label: "Read file", count: calls.length, calls }] }],
    });

    it("shows each call with its own result", () => {
      const chain = linkEntries("reused", [
        call("a.md"),
        result("paused: awaiting approval"),
        call("b.md"),
        result("contents of b"),
        call("c.md"),
      ]);
      expect(projectThreadItems(chain)).toEqual([
        readFiles("reused-0", [
          shown("a.md", "paused: awaiting approval"),
          shown("b.md", "contents of b"),
          shown("c.md", ""),
        ]),
      ]);
    });

    it("gives the result to the call the resumed run replayed, leaving the cut call open", () => {
      const chain = linkEntries("crash", [call("a.md"), call("b.md"), result("contents of b")]);
      expect(projectThreadItems(chain)).toEqual([
        readFiles("crash-0", [shown("a.md", ""), shown("b.md", "contents of b")]),
      ]);
    });

    it("drops a result whose call the compaction cut, so later calls keep their own", () => {
      const chain = linkEntries("cut", [
        call("a.md"),
        { type: "compaction", payload: { summary: "Reading notes.", coveredUpToSeq: 0 } },
        result("alpha"),
        call("b.md"),
        result("beta"),
      ]).slice(1);
      expect(projectThreadItems(chain)).toEqual([
        { kind: "divider", id: "cut-1", ts: at(1), reason: "compaction" },
        readFiles("cut-3", [shown("b.md", "beta")]),
      ]);
    });
  });

  it("drops the running helper once its run is cancelled before the helper answered", () => {
    const run = { botId: "bot_ada", runId: "run_1" };
    const trigger = { kind: "webhook", routineId: "rtn_1" };
    const input = JSON.stringify({ name: "scout", task: "List competitors" });
    const usage = { inputTokens: 300, outputTokens: 5 };
    const chain = linkEntries("stop", [
      { ...run, type: "run.started", payload: { trigger, model, effort: null } },
      {
        ...run,
        type: "tool.call",
        payload: { callId: "call_scout", name: "run_subagent", input },
      },
      { ...run, type: "run.finished", payload: { status: "cancelled", usage } },
    ]);
    expect(projectThreadItems(chain)).toEqual([
      {
        kind: "run",
        id: "stop-0",
        ts: at(0),
        ...run,
        trigger,
        model,
        effort: null,
        finished: { outcome: { status: "cancelled", usage }, durationMs: 2000 },
      },
      {
        kind: "message",
        role: "bot",
        id: "stop-1",
        ts: at(1),
        ...run,
        blocks: [
          {
            kind: "steps",
            durationMs: 2000,
            steps: [
              {
                label: "Run subagent",
                count: 1,
                calls: [{ name: "run_subagent", input, output: "", id: "call_scout" }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it("stamps the run's duration on the last steps block of its words once it finishes", () => {
    const run = { botId: "bot_ada", runId: "run_1" };
    const trigger = { kind: "webhook", routineId: "rtn_1" };
    const usage = { inputTokens: 300, outputTokens: 5 };
    const call = (callId: string) => ({
      ...run,
      type: "tool.call",
      payload: { callId, name: "read_file", input: "{}" },
    });
    const result = (callId: string) => ({
      ...run,
      type: "tool.result",
      payload: { callId, output: "ok", isError: false, artifactIds: [] },
    });
    const chain = linkEntries("timed", [
      { ...run, type: "run.started", payload: { trigger, model, effort: null } },
      call("call_a"),
      result("call_a"),
      { ...run, type: "assistant.text", payload: { blocks: text("Reading more.") } },
      call("call_b"),
      result("call_b"),
      { ...run, type: "assistant.text", payload: { blocks: text("Done.") } },
      { ...run, type: "run.finished", payload: { status: "completed", usage } },
    ]);
    const read = (id: string) => ({
      label: "Read file",
      count: 1,
      calls: [{ name: "read_file", input: "{}", output: "ok", id }],
    });
    expect(projectThreadItems(chain)).toEqual([
      {
        kind: "run",
        id: "timed-0",
        ts: at(0),
        ...run,
        trigger,
        model,
        effort: null,
        finished: { outcome: { status: "completed", usage }, durationMs: 7000 },
      },
      {
        kind: "message",
        role: "bot",
        id: "timed-1",
        ts: at(1),
        ...run,
        blocks: [
          { kind: "steps", steps: [read("call_a")] },
          { kind: "text", text: "Reading more." },
          { kind: "steps", steps: [read("call_b")], durationMs: 7000 },
          { kind: "text", text: "Done." },
        ],
      },
    ]);
  });

  it("gives a run finished at a timestamp before its start a duration of zero", () => {
    const run = { botId: "bot_ada", runId: "run_1" };
    const trigger = { kind: "webhook", routineId: "rtn_1" };
    const usage = { inputTokens: 300, outputTokens: 5 };
    const chain = linkEntries("skew", [
      { ...run, ts: at(5), type: "run.started", payload: { trigger, model, effort: null } },
      { ...run, ts: at(3), type: "run.finished", payload: { status: "completed", usage } },
    ]);
    expect(projectThreadItems(chain)).toEqual([
      {
        kind: "run",
        id: "skew-0",
        ts: at(5),
        runId: "run_1",
        botId: "bot_ada",
        trigger,
        model,
        effort: null,
        finished: { outcome: { status: "completed", usage }, durationMs: 0 },
      },
    ]);
  });

  it("shows the words of a run whose start and first call are before the page", async () => {
    const page = (await fixtureChain("compacted")).filter((entry) => entry.seq >= 13);
    expect(projectThreadItems(page)).toEqual([
      {
        kind: "message",
        role: "bot",
        id: "cmp-14",
        ts: at(14),
        botId: "bot_ada",
        runId: "run_cmp_3",
        blocks: [
          {
            kind: "steps",
            steps: [
              {
                label: "Send email",
                count: 1,
                calls: [
                  { name: "send_email", input: '{"to":"team"}', output: "sent", id: "call_mail" },
                ],
              },
            ],
          },
          { kind: "text", text: "Digest sent: 3 articles about the launch." },
        ],
      },
    ]);
  });
});
