import assert from "node:assert/strict";
import { EncryptedSecretStore } from "@rakazo/adapters";
import { latestCard } from "../index.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "../model-emulator.js";
import { call, finish, liveRun } from "./run.js";
import type { Lane } from "./session.js";

const ANCHOR = "n13-history-anchor";
const SUMMARY =
  "N13_PI_COMPACTED. The approved note was published once. Preserve n13-history-anchor. The volume contains n13-effect.txt. Continue privately.";

export const laneNativeCompaction: Lane = {
  id: "native-compaction",
  issue: "N13 actual Pi compaction through the controller relay",
  scenario:
    "An approved controller effect precedes native volume writes, then a model protocol overflow forces Pi to summarize and continue in a configured 32768-token context",
  passWhen:
    "Pi requests summarization through the relay and retries with its summary, the canonical controller log keeps the original paired calls and approval outcome, and a later attempt replays the canonical private recap rather than trusting the harness summary",
  async run(live) {
    assert.equal(live.config.harness ?? "pi-native", "pi-native");
    let effects = 0;
    let prefix = "";
    let summaryRequests = 0;
    let compactedRequest = false;
    let replayedCanonicalHistory = false;
    const inspectPrefix = (request: ModelEmulatorRequest) => {
      const current = JSON.stringify(
        request.messages.filter((message) => message.role === "system"),
      );
      if (prefix) assert.ok(current === prefix, "N8 prefix changed before compaction");
      prefix = current;
    };
    const filling: ModelEmulatorStep[] = Array.from({ length: 9 }, (_, index) => ({
      expect(request) {
        inspectPrefix(request);
        assert.ok(JSON.stringify(request.messages).includes("approved-controller-outcome"));
      },
      response: {
        type: "tool",
        id: `fill-${index}`,
        name: "bash",
        arguments: {
          command: `printf 'volume-effect\\n' > n13-effect.txt; printf '${ANCHOR}-${index} '; head -c 16000 /dev/zero | tr '\\0' '${index}'`,
        },
        usage: { promptTokens: 100, completionTokens: 10 },
      },
    }));
    const worker = await liveRun(live, {
      tools: {
        describe: () => ({
          id: "n13",
          contractVersion: "1",
          adapterVersion: "1",
          capabilities: { discover: true, oauth: false, secretsBrokered: true },
        }),
        discoverTools: async () => [
          {
            name: "publish_note",
            description: "Publish one synthetic note",
            inputSchema: { type: "object", properties: { title: { type: "string" } } },
            route: { connectorId: "n13", resourceId: "synthetic-notes", toolName: "publish_note" },
          },
        ],
        async *execute() {
          effects += 1;
          yield { type: "result", data: { outcome: "approved-controller-outcome" } };
        },
      },
      steps: [
        call("approval", "publish_note", { title: ANCHOR }),
        { expect() {}, response: { type: "text", text: "Waiting for approval." } },
        ...filling,
        {
          expect(request) {
            inspectPrefix(request);
            assert.ok(JSON.stringify(request.messages).includes(`${ANCHOR}-0`));
          },
          response: { type: "error", status: 400, message: "maximum context length exceeded" },
        },
        {
          expect(request) {
            const text = JSON.stringify(request.messages);
            assert.match(text, /summari[sz]|summary/i);
            assert.ok(text.includes(ANCHOR));
            assert.ok(!request.tools?.length, "Pi summarization must be a separate model call");
            summaryRequests += 1;
          },
          response: { type: "text", text: SUMMARY },
        },
        {
          expect(request) {
            const text = JSON.stringify(request.messages);
            assert.match(text, /summari[sz]|summary/i);
            assert.ok(text.includes(ANCHOR));
            assert.ok(!request.tools?.length);
            summaryRequests += 1;
          },
          response: { type: "text", text: SUMMARY },
        },
        call("volume-read", "bash", { command: "cat n13-effect.txt" }, (request) => {
          const text = JSON.stringify(request.messages);
          assert.ok(text.includes("N13_PI_COMPACTED"));
          assert.ok(!text.includes(`${ANCHOR}-0 `), "Pi did not replace the old history");
          for (const [index, message] of request.messages.entries()) {
            if (message.role !== "tool") continue;
            assert.equal(
              request.messages
                .slice(0, index)
                .flatMap((prior) => prior.tool_calls ?? [])
                .filter((call) => call.id === message.tool_call_id).length,
              1,
              "Compaction orphaned a tool result",
            );
          }
          compactedRequest = true;
        }),
        ...finish(
          "approved-controller-outcome n13-history-anchor, compacted privately",
          (request) => {
            const readResults = request.messages.filter(
              (message) => message.role === "tool" && message.tool_call_id === "volume-read",
            );
            assert.equal(readResults.length, 1);
            assert.equal(readResults[0]?.content, "volume-effect\n");
            assert.equal(effects, 1);
          },
        ),
        ...finish("Replayed canonical history", (request) => {
          const text = JSON.stringify(request.messages);
          assert.ok(text.includes("approved-controller-outcome"));
          assert.ok(text.includes(ANCHOR));
          assert.ok(!text.includes("N13_PI_COMPACTED"));
          replayedCanonicalHistory = true;
        }),
      ],
    });
    try {
      const credential = await worker.run.prisma.userModelCredential.findFirstOrThrow({
        where: { userId: worker.run.userId },
      });
      const store = new EncryptedSecretStore("worker-fixture-encryption-key");
      const secret = await worker.run.prisma.secret.findUniqueOrThrow({
        where: { id: credential.secretId },
      });
      const configured = JSON.parse(store.load(secret.ciphertext, secret.id));
      const sealed = await store.put(JSON.stringify({ ...configured, contextWindow: 32768 }), {
        operationId: "compaction",
        traceId: "compaction",
        spaceId: worker.run.spaceId,
        userId: worker.run.userId,
        signal: new AbortController().signal,
      });
      await worker.run.prisma.secret.create({
        data: {
          id: sealed.id,
          userId: worker.run.userId,
          kind: "model",
          ciphertext: sealed.ciphertext,
        },
      });
      await worker.run.prisma.userModelCredential.update({
        where: { id: credential.id },
        data: { secretId: sealed.id },
      });
      await worker.run.prisma.actionApprovalRule.create({
        data: {
          spaceId: worker.run.spaceId,
          createdByUserId: worker.run.userId,
          effect: "require_approval",
          matchKind: "tool",
          matchValue: "publish_note",
        },
      });
      const runId = await worker.send(`Publish one note, then keep the outcome private. ${ANCHOR}`);
      assert.equal(await worker.status(runId), "waiting_input");
      assert.equal(effects, 0);
      const card = await latestCard(worker.run.prisma, runId);
      assert.ok(
        await worker.run.events.answerRunInput({
          spaceId: worker.run.spaceId,
          threadId: worker.run.thread.id,
          runId,
          messageId: card.id,
          answeredByUserId: worker.run.userId,
          answer: "allow",
        }),
      );
      worker.run.restart();
      await worker.run.continueRun(runId);
      if ((await worker.status(runId)) !== "completed") worker.run.model.assertComplete();
      assert.equal(await worker.status(runId), "completed");
      const entries = await worker.run.runEntries(runId);
      const summaries = entries.filter((entry) => entry.type === "harness.summary");
      assert.equal(summaries.length, 1);
      assert.ok(summaries[0]?.payload.summary.includes("N13_PI_COMPACTED"));
      assert.ok(summaries[0] && summaries[0].payload.tokensBefore > 0);
      const calls = entries.filter((entry) => entry.type === "tool.call");
      const results = entries.filter((entry) => entry.type === "tool.result");
      const readCall = calls.find((entry) => entry.payload.callId === "volume-read");
      assert.ok(readCall, "Missing volume-read call");
      const readResult = results.find((entry) => entry.payload.callId === readCall.payload.callId);
      assert.ok(readResult, "Missing volume-read result");
      assert.equal(readResult.payload.isError, false);
      assert.equal(readResult.payload.output, "volume-effect\n");
      for (const call of calls)
        assert.equal(
          results.filter((result) => result.payload.callId === call.payload.callId).length,
          1,
        );
      assert.equal(calls.filter((entry) => entry.payload.name === "bash").length, 10);
      assert.ok(
        results.some((entry) => entry.payload.output.includes("approved-controller-outcome")),
      );
      assert.ok(results.some((entry) => entry.payload.output.includes(`${ANCHOR}-0`)));
      const replayModel = await store.put(
        JSON.stringify({ ...configured, contextWindow: 131072 }),
        {
          operationId: "replay",
          traceId: "replay",
          spaceId: worker.run.spaceId,
          userId: worker.run.userId,
          signal: new AbortController().signal,
        },
      );
      await worker.run.prisma.secret.create({
        data: {
          id: replayModel.id,
          userId: worker.run.userId,
          kind: "model",
          ciphertext: replayModel.ciphertext,
        },
      });
      await worker.run.prisma.userModelCredential.update({
        where: { id: credential.id },
        data: { secretId: replayModel.id },
      });
      const nextId = await worker.send("Continue privately from the canonical history.");
      worker.run.model.assertComplete();
      await worker.completed(nextId);
      assert.equal(effects, 1);
      assert.equal(summaryRequests, 2);
      assert.ok(compactedRequest && replayedCanonicalHistory);
      return {
        pass: true,
        observed: {
          model:
            "protocol emulator, including one controlled context-overflow response and generated summary",
          contextWindow: 32768,
          replayContextWindow: 131072,
          fixtureUsage:
            "Low synthetic usage suppresses threshold compaction before the controlled overflow",
          trigger: "Pi overflow recovery",
          summaryRequests,
          compactedRequest,
          replayedCanonicalHistory,
          approvedEffects: effects,
          canonicalToolPairs: calls.length,
          canonicalNativeCalls: 10,
          summaries: summaries.map((entry) => ({ tokensBefore: entry.payload.tokensBefore })),
          volumeWriteAndRead: true,
          prefixStableBeforeCompaction: true,
          attempts: (await worker.attempts(runId)).map(({ workerState }) => workerState),
        },
      };
    } finally {
      await worker.close();
    }
  },
};
