const FILLER = "The quarterly numbers came back and the team wants a short written recap. ".repeat(
  5,
);
const RUN_SHAPE = [
  "user.message",
  "run.started",
  "assistant.text",
  "tool.call",
  "tool.result",
  "assistant.text",
  "run.finished",
] as const;

export function longSessionJsonl(options: {
  count: number;
  compactionEvery: number;
  rewind?: { at: number; to: number };
}): string {
  const lines: string[] = [];
  for (let seq = 0; seq < options.count; seq += 1) {
    const rewinds = options.rewind?.at === seq;
    const envelope = {
      id: `long-${seq}`,
      sessionId: "ses_long",
      seq,
      parentId: rewinds ? `long-${options.rewind?.to}` : seq === 0 ? null : `long-${seq - 1}`,
      ts: new Date(Date.UTC(2026, 9, 10) + seq * 1000).toISOString(),
    };
    const body =
      seq % options.compactionEvery === 0
        ? { type: "compaction", payload: { summary: FILLER, coveredUpToSeq: seq } }
        : rewinds
          ? { type: "rewind", payload: {} }
          : exchangeEntry(seq);
    lines.push(`${JSON.stringify({ ...envelope, ...body })}\n`);
  }
  return lines.join("");
}

function exchangeEntry(seq: number) {
  const run = Math.floor(seq / RUN_SHAPE.length);
  const own = { botId: "bot_ada", runId: `run_${run}` };
  const callId = `call_${run}`;
  const type = RUN_SHAPE[seq % RUN_SHAPE.length] ?? "assistant.text";
  switch (type) {
    case "user.message":
      return { type, payload: { blocks: [{ kind: "text", text: FILLER }], source: "app" } };
    case "run.started":
      return {
        ...own,
        type,
        payload: {
          trigger: { kind: "message", entryId: `long-${seq - 1}` },
          model: { provider: "emulator", id: "emulator-1" },
          effort: null,
        },
      };
    case "tool.call":
      return {
        ...own,
        type,
        payload: { callId, name: "read_file", input: `{"path":"report-${run}.md"}` },
      };
    case "tool.result":
      return { ...own, type, payload: { callId, output: FILLER, isError: false, artifactIds: [] } };
    case "run.finished":
      return {
        ...own,
        type,
        payload: { status: "completed", usage: { inputTokens: 900, outputTokens: 80 } },
      };
    case "assistant.text":
      return { ...own, type, payload: { blocks: [{ kind: "text", text: FILLER }] } };
  }
}
