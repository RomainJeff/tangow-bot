import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@tangow/adapter-kit";
import { abortableDelay, inferHandoffTargetName } from "@tangow/core";
import { helperCallOf, helperModel } from "./builtin-tools.js";

const running = new Map<string, AbortController>();
/** Runs that stopped on a question card, so their next turn answers it. */
const asked = new Set<string>();
const CHOICE_REPLY_DELAY_MS = 1_200;

export class ScriptedAgentRuntime implements AgentRuntime {
  describe() {
    return {
      id: "scripted",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: true },
    };
  }

  async abort(runId: string): Promise<void> {
    running.get(runId)?.abort();
  }

  async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    const controller = new AbortController();
    running.set(request.runId, controller);
    const signal = context?.signal ?? controller.signal;
    try {
      if (shouldFail(request.prompt)) {
        throw new Error("Scripted run failure");
      }
      if (shouldHang(request.prompt)) {
        yield { type: "progress", text: "still working…", activity: true };
        while (!controller.signal.aborted && !signal.aborted) {
          await abortableDelay(50, controller.signal);
          if (controller.signal.aborted || signal.aborted) break;
          yield { type: "progress", text: "still working…", activity: true };
        }
        yield { type: "done", text: "stopped" };
        return;
      }
      // A model takes longer than a card's commit movement to answer the card; replying inside
      // it would move the thread mid-flight and blur what the motion e2e measures.
      if (asked.delete(request.runId)) await abortableDelay(CHOICE_REPLY_DELAY_MS, signal);
      if (request.helper) {
        const result = helperResult(request.helper.task);
        yield { type: "text", text: result };
        yield { type: "done", text: result };
        return;
      }
      const report = request.prompt.includes(HELPER_WAKE) && helperReportOf(request.history);
      const script = report
        ? [{ assistant: `the helper reported back. ${report}`, complete: true }]
        : (request.script ?? inferScript(request.prompt, request.resumeFromCheckpoint));
      // Per-run call index so repeated tools (e.g. message_agent) get distinct
      // executionIds — delivery keys and effect replays key off this value.
      let toolCallSeq = 0;
      // Text after the run's last tool call, ask or takeover is its reply, which a model sends
      // with message_user when the run offers it; earlier text is private narration.
      const sendsReply = request.tools.some((tool) => tool.name === "message_user");
      const lastInterrupt = script.findLastIndex((turn) =>
        Boolean(turn.toolCalls?.length || turn.ask || turn.takeover),
      );
      for (const [index, turn] of script.entries()) {
        if (signal.aborted || controller.signal.aborted) {
          yield { type: "done", text: "stopped" };
          return;
        }
        if (turn.assistant) {
          yield { type: "progress", text: "working…", activity: true };
          if (sendsReply && index > lastInterrupt) {
            yield messageUser(request.runId, turn.assistant, toolCallSeq++);
          } else {
            yield { type: "text", text: turn.assistant };
          }
        }
        for (const call of turn.toolCalls ?? []) {
          const executionId = `${request.runId}:${call.name}:${toolCallSeq++}`;
          yield { type: "tool", name: call.name, args: call.args, executionId };
          if (call.name === "run_subagent" && call.args.background && request.startHelper) {
            await request.startHelper({
              callId: executionId,
              name: String(call.args.name ?? "helper"),
              task: String(call.args.task ?? request.prompt),
              args: call.args,
              ...(await helperModel(request, helperCallOf(call.args))),
            });
          } else if (call.name === "run_subagent" && request.startSubagent) {
            const task = String(call.args.task ?? request.prompt);
            const log = await request.startSubagent({
              callId: executionId,
              name: String(call.args.name ?? "helper"),
              task,
              args: call.args,
              ...(await helperModel(request, helperCallOf(call.args))),
            });
            const result = helperResult(task);
            await log.text(result);
            await log.finish({
              status: "completed",
              result,
              usage: { inputTokens: 0, outputTokens: 0 },
            });
          }
        }
        if (turn.ask) {
          asked.add(request.runId);
          yield {
            type: "ask",
            text: turn.ask.text,
            detail: turn.ask.detail,
            actions: turn.ask.actions,
            questions: turn.ask.questions,
          };
          return;
        }
        if (turn.takeover) {
          yield { type: "takeover", reason: turn.takeover.reason };
          return;
        }
        if (turn.complete) {
          yield {
            type: "usage",
            inputTokens: 12,
            outputTokens: 40,
            provider: "scripted",
            model: "scripted",
          };
          yield { type: "done", text: turn.assistant };
          return;
        }
      }
      if (sendsReply) yield messageUser(request.runId, "done.", toolCallSeq++);
      else yield { type: "text", text: "done." };
      yield { type: "done", text: "done." };
    } finally {
      controller.abort();
      running.delete(request.runId);
    }
  }
}

function helperResult(task: string): string {
  return `it found: ${task.slice(0, 180)}`;
}

/** The prompt of the run a background helper's report wakes. */
const HELPER_WAKE = "A helper you started wrote back.";

/** The newest helper report the history hands the bot. */
function helperReportOf(history: AgentRunRequest["history"]): string | undefined {
  const turn = history.findLast((candidate) => candidate.content.includes("<helper_report>"));
  const data = turn?.content.split("<helper_report>\n")[1]?.split("\n</helper_report>")[0];
  if (!data) return undefined;
  const { report } = JSON.parse(data) as { report?: unknown };
  return typeof report === "string" ? report : undefined;
}

function messageUser(runId: string, message: string, seq: number): AgentRuntimeEvent {
  return {
    type: "tool",
    name: "message_user",
    args: { message },
    executionId: `${runId}:message_user:${seq}`,
  };
}

export function inferScript(
  prompt: string,
  resumeFromCheckpoint?: string,
): NonNullable<AgentRunRequest["script"]> {
  const lower = prompt.toLowerCase();
  if (resumeFromCheckpoint === "takeover-skipped") {
    return [
      {
        assistant: "login was skipped. continuing without treating sign-in as done.",
        complete: true,
      },
    ];
  }
  if (resumeFromCheckpoint === "takeover") {
    return [
      {
        assistant:
          "signed in. the session stays in this computer — protected input never hit the thread.",
        complete: true,
      },
    ];
  }
  // Before every content-based intent so payload text cannot steal the branch.
  if (lower.includes("message the bot named") || lower.includes("message bot named")) {
    const name = namedBot(prompt) ?? "Peer";
    const message =
      /named\s+[A-Za-z0-9][A-Za-z0-9_-]{0,39}\s+(?:saying|with|:)\s*([\s\S]+)$/i
        .exec(prompt)?.[1]
        ?.trim() ?? `Please help with: ${prompt}`;
    return [
      {
        assistant: "messaging that bot now.",
        toolCalls: [
          {
            name: "message_bot",
            args: {
              confirm_name: name,
              message,
              intent: "request",
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("masked secret card") ||
    lower.includes("show a secret card") ||
    lower.includes("request a masked api key")
  ) {
    return [
      {
        assistant: "i need that value in a protected field.",
        toolCalls: [
          {
            name: "request_secret",
            args: {
              label: "API key",
              purpose: "api_key",
              credential: {
                name: "example_api",
                origin: "https://api.example.test",
                auth: { type: "bearer" },
              },
            },
          },
        ],
      },
    ];
  }
  if (
    lower.includes("tappable choices") ||
    lower.includes("choice buttons") ||
    lower.includes("pick from these cities")
  ) {
    return [
      {
        assistant: "pick one to continue.",
        ask: {
          text: "Which city should I use?",
          detail: "Tap one option.",
          actions: [
            { id: "choice-1", label: "Berlin" },
            { id: "choice-2", label: "Seoul" },
            { id: "choice-3", label: "Toronto" },
            { id: "choice-4", label: "Lisbon" },
          ],
        },
      },
    ];
  }
  if (lower.includes("ask me three questions")) {
    return [
      {
        assistant: "three quick questions so i look at the right fridges.",
        ask: {
          text: "Three quick questions about the fridge.",
          questions: [
            {
              id: "q1",
              header: "Format",
              question: "Which fridge do you have now?",
              options: [
                {
                  id: "q1o1",
                  label: "Freestanding, 60 cm",
                  description: "Fits most kitchens",
                  recommended: true,
                },
                {
                  id: "q1o2",
                  label: "Built-in, 54–56 cm",
                  description: "Hides behind a cabinet door",
                },
                { id: "q1o3", label: "American or XXL" },
              ],
            },
            {
              id: "q2",
              header: "Extras",
              question: "What should the new one have?",
              multiSelect: true,
              options: [
                { id: "q2o1", label: "Ice maker" },
                { id: "q2o2", label: "No frost" },
                { id: "q2o3", label: "Quiet, under 38 dB" },
              ],
            },
            {
              id: "q3",
              question: "Do you already have a separate freezer?",
              required: false,
              options: [
                { id: "q3o1", label: "Yes, we have one" },
                { id: "q3o2", label: "No, quote one too" },
              ],
            },
          ],
        },
      },
    ];
  }
  if (
    lower.includes("ask me") ||
    lower.includes("which city") ||
    lower.includes("need a decision")
  ) {
    return [
      {
        assistant: "i need a decision before i continue.",
        ask: { text: "Which city should I use?", detail: "Reply with one city name." },
      },
    ];
  }
  if (lower.includes("take over") || lower.includes("sign in") || lower.includes("login")) {
    return [
      { assistant: "i need you on the screen for a one-time sign-in. handing you the computer." },
      { takeover: { reason: "Sign in to continue. Protected input stays off the thread." } },
    ];
  }
  if (
    lower.includes("observe your screen") ||
    lower.includes("look at your screen") ||
    lower.includes("use your screen")
  ) {
    const typed = /type\s+([A-Za-z0-9._-]+)/i.exec(prompt)?.[1] ?? "ready";
    return [
      {
        assistant: "using my screen now.",
        toolCalls: [
          { name: "computer_observe", args: {} },
          {
            name: "computer_act",
            args: {
              actions: [{ kind: "type", text: typed }],
              observe: true,
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("delete the bot named") ||
    lower.includes("delete the child bot") ||
    lower.includes("delete child")
  ) {
    const name = namedBot(prompt) ?? "Scout";
    return [
      {
        assistant: "archiving that bot.",
        toolCalls: [{ name: "archive_bot", args: { confirm_name: name } }],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("create a space") ||
    lower.includes("create space") ||
    lower.includes("new space named") ||
    lower.includes("new private space")
  ) {
    const name = namedSpace(prompt) ?? "New space";
    return [
      {
        assistant: "i can create that separate space after you confirm the boundary.",
        toolCalls: [{ name: "create_space", args: { name } }],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("spawn a bot") ||
    lower.includes("spawn a child") ||
    lower.includes("create a bot named") ||
    lower.includes("create a child bot")
  ) {
    const name = namedBot(prompt) ?? "Helper";
    return [
      {
        assistant: "i can create that bot once you approve the card.",
        toolCalls: [
          {
            name: "spawn_bot",
            args: {
              name,
              title: `${name} specialist`,
              instructions: `You are ${name}.`,
              prompt: "Start on the assigned work.",
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (lower.includes("in the background")) {
    return [
      {
        toolCalls: [
          {
            name: "run_subagent",
            args: { name: "helper", category: "everyday", task: prompt, background: true },
          },
        ],
      },
      { assistant: "I've started that, I'll come back with it.", complete: true },
    ];
  }
  if (lower.includes("subagent") || lower.includes("delegate to a helper")) {
    return [
      {
        assistant: "spinning up a helper for that.",
        toolCalls: [
          { name: "run_subagent", args: { name: "helper", category: "everyday", task: prompt } },
        ],
      },
      { assistant: `the helper is done. ${helperResult(prompt)}`, complete: true },
    ];
  }
  if (
    lower.includes("hand this to") ||
    lower.includes("hand off to") ||
    lower.includes("handoff to") ||
    (lower.includes("@writer") && lower.includes("draft"))
  ) {
    const target = inferHandoffTargetName(prompt) ?? "Writer";
    return [
      {
        assistant: "handing this off in the group thread.",
        toolCalls: [
          {
            name: "handoff_to_bot",
            args: {
              confirm_name: target,
              message: prompt,
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (lower.startsWith("run taught skill:") || lower.includes("this is a safe test")) {
    return [
      {
        assistant:
          "Running the taught skill using its saved playbook. I will follow the demonstrated steps and report the result.",
        complete: true,
      },
    ];
  }
  if (/^run\s+/.test(lower)) {
    return [
      {
        assistant:
          "Using the saved taught skill playbook for that request and following its steps.",
        complete: true,
      },
    ];
  }
  if (lower.includes("connector") || lower.includes("crm") || lower.includes("destination")) {
    return [
      {
        assistant: "writing the record through the connected destination.",
        toolCalls: [
          {
            name: "destination.write",
            args: { collection: "notes", title: "Rakazo result", body: prompt },
          },
        ],
        complete: true,
      },
    ];
  }
  if (lower.includes("send me a screenshot")) {
    return [{ toolCalls: [{ name: "computer_observe", args: { attach: true } }], complete: true }];
  }
  if (lower.includes("attach") && (lower.includes("thread") || lower.includes("into the thread"))) {
    const said = /says?\s+(.+)$/i.exec(prompt)?.[1]?.replace(/[.]+$/, "") ?? prompt;
    const content = `${said.trim()}\n`;
    const filePath =
      /(?:called|named|path|file)\s+([A-Za-z0-9._/-]+)/i.exec(prompt)?.[1] ?? "notes/result.txt";
    return [
      { assistant: "writing that into my home and attaching it to the thread." },
      { toolCalls: [{ name: "write_file", args: { path: filePath, content, overwrite: true } }] },
      { toolCalls: [{ name: "attach_file", args: { path: filePath } }], complete: true },
    ];
  }
  if (
    lower.includes("write") &&
    (lower.includes("file") || lower.includes("home") || lower.includes("note"))
  ) {
    const said = /says?\s+(.+)$/i.exec(prompt)?.[1]?.replace(/[.]+$/, "") ?? prompt;
    const content = `${said.trim()}\n`;
    const filePath =
      /(?:called|named)\s+([A-Za-z0-9._/-]+)/i.exec(prompt)?.[1] ?? "notes/result.txt";
    return [
      { assistant: "writing that into my home now." },
      {
        toolCalls: [{ name: "write_file", args: { path: filePath, content, overwrite: true } }],
        complete: true,
      },
    ];
  }
  if (lower.includes("remember for the team")) {
    const fact = prompt.replace(/^.*remember for the team( that)?\s*/i, "").trim() || prompt;
    return [
      { toolCalls: [{ name: "remember", args: { content: fact, team: true } }] },
      { assistant: "noted for the team.", complete: true },
    ];
  }
  if (lower.includes("remember")) {
    return [
      {
        assistant: "noted — i will keep that in memory.",
        memory: [{ scope: "bot", path: "MEMORY.md", content: `# Memory\n\n- ${prompt}\n` }],
        complete: true,
      },
    ];
  }
  return [
    {
      assistant: `on it. i will work this in the background and come back with a result.\n\n${summarize(prompt)}`,
    },
    {
      files: [{ path: "notes/last-task.md", content: `# Task\n\n${prompt}\n` }],
      complete: true,
    },
  ];
}

function shouldFail(prompt: string): boolean {
  return prompt.toLowerCase().includes("fail this run");
}

function shouldHang(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return (
    lower.includes("keep working") ||
    lower.includes("work until i stop") ||
    lower.includes("until i stop you") ||
    lower.includes("hang until stopped")
  );
}

function namedBot(prompt: string) {
  return /named\s+([A-Za-z0-9][A-Za-z0-9_-]{0,39})/i.exec(prompt)?.[1];
}

function namedSpace(prompt: string) {
  return /space\s+(?:named|called)\s+["“]?([^"”\n]{1,60})/i
    .exec(prompt)?.[1]
    ?.replace(/[.!?]+$/, "")
    .trim();
}

function summarize(prompt: string): string {
  return `done. i handled: ${prompt.slice(0, 180)}`;
}
