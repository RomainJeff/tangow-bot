import { latestCard } from "../index.js";
import { prepares } from "../model-emulator.js";
import { call, finish, liveRun } from "./run.js";
import type { Lane } from "./session.js";
import { forward } from "./session.js";

export const laneNativeApproval: Lane = {
  id: "native-helper-approval",
  issue: "N13 native helper ownership and approval recovery",
  scenario:
    "A native helper submits a connector action requiring approval, then concurrent resumes after controller restart settle the effect once",
  passWhen:
    "The helper sees its own task without root history, uses the parent's worker, persists one child run, and the approved action executes once after restart",
  async run(live) {
    const published: unknown[] = [];
    let helperOwnContext = false;
    let launches = 0;
    const worker = await liveRun(live, {
      computer: "none",
      wrap: (provider) =>
        forward(provider, {
          async ensure(spec, ctx) {
            launches += 1;
            return provider.ensure(spec, ctx);
          },
        }),
      tools: {
        describe: () => ({
          id: "notes",
          contractVersion: "1",
          adapterVersion: "1",
          capabilities: { discover: true, oauth: false, secretsBrokered: true },
        }),
        discoverTools: async () => [
          {
            name: "publish_note",
            description: "Publish a synthetic note",
            inputSchema: { type: "object", properties: { title: { type: "string" } } },
            route: { connectorId: "notes", resourceId: "notes-server", toolName: "publish_note" },
          },
        ],
        async *execute(request) {
          published.push(request.args);
          yield { type: "result", data: { published: request.args.title } };
        },
      },
      steps: [
        call("delegate", "run_subagent", {
          name: "Publisher",
          task: "Publish the synthetic plan.",
        }),
        call("publish", "publish_note", { title: "Synthetic plan" }, (request) => {
          const text = JSON.stringify(request.messages);
          helperOwnContext =
            text.includes("Publish the synthetic plan.") && !text.includes("root-private-marker");
        }),
        prepares(),
        { expect() {}, response: { type: "text", text: "Waiting." } },
        ...finish("Published the synthetic plan"),
      ],
    });
    try {
      await worker.run.prisma.actionApprovalRule.create({
        data: {
          spaceId: worker.run.spaceId,
          createdByUserId: worker.run.userId,
          effect: "require_approval",
          matchKind: "tool",
          matchValue: "publish_note",
        },
      });
      const runId = await worker.send("Publish a plan. root-private-marker");
      const paused = await worker.status(runId);
      const beforeApproval = published.length;
      const launchesBeforeApproval = launches;
      const card = await latestCard(worker.run.prisma, runId);
      const answered = await worker.run.events.answerRunInput({
        spaceId: worker.run.spaceId,
        threadId: worker.run.thread.id,
        runId,
        messageId: card.id,
        answeredByUserId: worker.run.userId,
        answer: "allow",
      });
      worker.run.restart();
      await Promise.all([worker.run.continueRun(runId), worker.run.continueRun(runId)]);
      await worker.run.continueRun(runId);
      await worker.completed(runId);
      const children = await worker.run.prisma.run.findMany({
        where: { parentRunId: runId },
        select: { status: true },
      });
      const effects = await worker.run.prisma.externalEffect.findMany({
        where: { runId, kind: "publish_note" },
        select: { status: true },
      });
      const observed = {
        paused,
        beforeApproval,
        answered,
        helperOwnContext,
        launchesBeforeApproval,
        launchesAfterResume: launches,
        childStatuses: children.map((child) => child.status),
        published,
        effectStatuses: effects.map((effect) => effect.status),
        attempts: (await worker.attempts(runId)).map(({ workerState }) => workerState),
      };
      return {
        pass:
          paused === "waiting_input" &&
          beforeApproval === 0 &&
          answered &&
          helperOwnContext &&
          launchesBeforeApproval === 1 &&
          launches === 2 &&
          children.length === 1 &&
          children[0]?.status === "completed" &&
          published.length === 1 &&
          JSON.stringify(published[0]) === JSON.stringify({ title: "Synthetic plan" }) &&
          effects.length === 1 &&
          effects[0]?.status === "completed",
        observed,
      };
    } finally {
      await worker.close();
    }
  },
};
