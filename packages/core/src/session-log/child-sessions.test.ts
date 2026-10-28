import { describe, expect, it } from "vitest";
import { sessionOriginOf } from "./child-sessions.js";
import { linkEntries } from "./fixtures/read-fixture.js";
import { projectThreadItems } from "./project-ui.js";

const model = { provider: "emulator", id: "emulator-1" };

describe("sessionOriginOf", () => {
  it("leaves the bot's reply from its own run or a helper's session unnamed, but names a routine's", () => {
    const reply = (runId: string, originSessionId: string, text: string) => ({
      botId: "bot_ada",
      runId,
      type: "assistant.text",
      payload: { toPerson: true, originSessionId, blocks: [{ kind: "text", text }] },
    });
    const chain = linkEntries("own", [
      {
        type: "user.message",
        payload: { blocks: [{ kind: "text", text: "How is Accor?" }], source: "app" },
      },
      {
        botId: "bot_ada",
        runId: "run_reply",
        type: "run.opened",
        payload: { sessionId: "ses_reply" },
      },
      reply("run_reply", "ses_reply", "Accor held 45."),
      {
        botId: "bot_ada",
        runId: "run_digest",
        type: "routine.started",
        payload: {
          sessionId: "ses_digest",
          routineId: "rtn_digest",
          name: "Digest",
          trigger: "routine",
          scheduledAt: "2026-10-10T09:00:00.000Z",
          model,
        },
      },
      reply("run_digest", "ses_digest", "Three new invoices"),
      {
        botId: "bot_ada",
        runId: "run_reply",
        type: "subagent",
        payload: {
          callId: "call_scout",
          sessionId: "ses_scout",
          name: "scout",
          model,
          task: "Check Accor",
          status: "completed",
          result: "Accor held 45.",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      },
      reply("run_reply", "ses_scout", "Checked."),
    ]);
    const origins = projectThreadItems(chain)
      .filter((item) => item.kind === "message" && item.role === "bot")
      .map(sessionOriginOf);
    expect(origins).toEqual([null, { sessionId: "ses_digest", name: "Digest" }, null]);
  });
});
