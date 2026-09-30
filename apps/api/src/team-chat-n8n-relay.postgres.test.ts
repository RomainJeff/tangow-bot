import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { EncryptedSecretStore } from "@rakazo/adapters";
import { completionMessageSegments } from "@rakazo/adapters";
import { isAmbientTeamChatRun } from "@rakazo/core";
import { createDb, createThreadEvents } from "@rakazo/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { TeamChatSender } from "./team-chat-access.js";
import { linkedTeamChatSenderCanInstruct } from "./team-chat-access.js";
import { TeamChatBridge } from "./team-chat-bridge.js";
import { ModelTeamChatEngagementJudge } from "./team-chat-judge.js";
import { mountTeamChatN8nRelayRoutes, TEAM_CHAT_N8N_RELAY_PATH } from "./team-chat-n8n-relay.js";

describe("team chat n8n relay", () => {
  it.skipIf(!process.env.VERIFY_DATABASE || !process.env.DATABASE_URL)(
    "relays an unlinked observation through persistence and empty completion silently",
    async () => {
      const { prisma, pool } = createDb(process.env.DATABASE_URL!);
      const send = vi.fn(async () => ({ handle: "neutralized" }));
      let bridge: TeamChatBridge | undefined;
      try {
        await prisma.organization.create({
          data: { id: "org", name: "Test", slug: "test", createdAt: new Date() },
        });
        await prisma.space.create({ data: { id: "w", name: "Test", organizationId: "org" } });
        await prisma.bot.create({
          data: {
            id: "b",
            spaceId: "w",
            userId: "owner",
            name: "Chief",
            color: "blue",
            teamChatAmbientEnabled: false,
          },
        });
        const rules =
          "Observe human exchanges. Act only for a useful contribution to an assigned mission. Logistics and requests for less presence remain silent.";
        await prisma.externalConversation.create({
          data: {
            provider: "slack",
            workspaceId: "T-test",
            externalKey: "C-test",
            conversationId: "slack:C-test:",
            spaceId: "w",
            userId: "owner",
            botId: "b",
            teamChatAmbientEnabled: true,
            teamChatRules: rules,
          },
        });
        const trusted = [
          {
            provider: "slack",
            botId: "b",
            workspaceId: "T-test",
            senderId: "U-relay",
            conversationKeys: ["C-test"],
          },
        ];
        const authorize = vi.fn((sender: TeamChatSender) =>
          linkedTeamChatSenderCanInstruct(prisma, "b", "slack", sender, trusted),
        );
        expect(
          await authorize({
            senderId: "U-unlinked",
            workspaceId: "T-test",
            conversationKey: "C-test",
          }),
        ).toBe(false);
        const judgeRuntime = {
          describe: vi.fn(),
          abort: vi.fn(async () => {}),
          run: vi.fn(async function* (request: AgentRunRequest) {
            expect(request.prompt).toContain(rules);
            yield {
              type: "done" as const,
              text: '{"act":true,"reason":"Potential useful contribution"}',
            };
          }),
        };
        const judge = new ModelTeamChatEngagementJudge({
          prisma,
          runtime: judgeRuntime,
          secrets: {} as EncryptedSecretStore,
          deploymentProvider: "test",
          deploymentModel: "dispatch-test-model",
        });
        const events = createThreadEvents(prisma);
        const jobs = { enqueue: vi.fn() };
        bridge = new TeamChatBridge({
          prisma,
          events,
          jobs,
          send,
          providerId: "slack",
          botId: "b",
          judge,
          authorizeSender: authorize,
          ambientDebounceMs: 0,
          reconcileIntervalMs: 3_600_000,
        });
        await bridge.start();
        const app = new Hono();
        mountTeamChatN8nRelayRoutes(app, {
          secret: "isolated-secret",
          bridge: () => bridge,
          botUserId: "U-ceo",
        });
        const content = "A potential issue in the assigned mission.";
        const response = await app.request(TEAM_CHAT_N8N_RELAY_PATH, {
          method: "POST",
          headers: { authorization: "Bearer isolated-secret", "content-type": "application/json" },
          body: JSON.stringify({
            provider: "slack",
            relaySenderId: "U-relay",
            workspaceId: "T-test",
            conversationKey: "C-test:100.1",
            conversationId: "slack:C-test:100.1",
            eventId: "100.2",
            replyThreadId: "100.1",
            sender: { id: "U-unlinked", name: "Unlinked participant" },
            content,
            kind: "ambient",
            slackEvent: {
              type: "message",
              user: "U-unlinked",
              channel: "C-test",
              ts: "100.2",
              thread_ts: "100.1",
              text: content,
            },
          }),
        });
        expect(response.status).toBe(202);
        await bridge.reconcileOnce();
        const observation = await prisma.externalMessage.findFirstOrThrow({
          where: { providerEventId: "100.2" },
        });
        expect(observation).toMatchObject({
          status: "running",
          relaySenderId: "U-relay",
          relayConversationKey: "C-test",
          kind: "ambient",
        });
        expect(judgeRuntime.run).toHaveBeenCalledTimes(1);
        expect(jobs.enqueue).toHaveBeenCalledTimes(1);
        const run = await prisma.run.findUniqueOrThrow({
          where: { id: observation.runId! },
          include: { externalMessage: { select: { kind: true } } },
        });
        const allowSilentEmpty = isAmbientTeamChatRun(run.trigger, run.externalMessage);
        expect(allowSilentEmpty).toBe(true);
        expect(isAmbientTeamChatRun("messaging", { kind: "mention" })).toBe(false);
        expect(isAmbientTeamChatRun("messaging", null)).toBe(false);
        // The executor reads the same persisted origin; the adapters suite proves an
        // empty turn with allowSilentEmpty finishes without a retry placeholder.
        const blocks = completionMessageSegments([], { allowSilentEmpty });
        expect(blocks).toEqual([]);
        await prisma.run.update({
          where: { id: run.id },
          data: { status: "completed", completedAt: new Date() },
        });
        await bridge.reconcileOnce();
        expect(
          await prisma.externalMessage.findUnique({ where: { id: observation.id } }),
        ).toMatchObject({ status: "delivered", providerReplyHandle: "silent" });
        expect(send).not.toHaveBeenCalled();
        // Losing provenance or changing its exact scope must fail even for this persisted author.
        expect(
          await authorize({
            senderId: observation.senderId,
            workspaceId: "T-test",
            conversationKey: "C-test:100.1",
          }),
        ).toBe(false);
        expect(
          await authorize({
            senderId: observation.senderId,
            relaySenderId: observation.relaySenderId!,
            relayConversationKey: "C-other",
            workspaceId: "T-test",
            conversationKey: "C-other:100.1",
          }),
        ).toBe(false);
      } finally {
        await bridge?.stop();
        await prisma.$disconnect();
        await pool.end();
      }
    },
  );
});
