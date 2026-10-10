import { describe, expect, it } from "vitest";
import { fixtureChain } from "./fixtures/read-fixture.js";
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
    expect(projectThreadItems(await fixtureChain("compacted"))).toEqual([
      { kind: "divider", id: "cmp-04", ts: at(4), reason: "compaction" },
      {
        kind: "run",
        id: "cmp-05",
        ts: at(5),
        runId: "run_cmp_2",
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
        id: "cmp-06",
        ts: at(6),
        botId: "bot_ada",
        runId: "run_cmp_2",
        blocks: [
          {
            kind: "steps",
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

  it("opens on the clear divider and keeps attachments, an ask, a choice and a control note", async () => {
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
        blocks: [{ kind: "ask", text: "Which day should it go out?" }],
      },
      {
        kind: "message",
        role: "user",
        id: "clr-06",
        ts: at(6),
        blocks: text("Tuesday."),
        replyTo: { entryId: "clr-04" },
        source: "app",
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
    ]);
  });

  it("shows the words of a run whose start and first call are before the page", async () => {
    const page = (await fixtureChain("compacted")).filter((entry) => entry.seq >= 7);
    expect(projectThreadItems(page)).toEqual([
      {
        kind: "message",
        role: "bot",
        id: "cmp-08",
        ts: at(8),
        botId: "bot_ada",
        runId: "run_cmp_2",
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
