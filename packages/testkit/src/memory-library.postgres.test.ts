import { randomUUID } from "node:crypto";
import type { SessionEntryDraft } from "@rakazo/adapter-kit";
import { PostgresSessionLog } from "@rakazo/adapters";
import type { SessionId } from "@rakazo/contracts";
import { MemoryConflictError } from "@rakazo/memory";
import { describe, expect, it } from "vitest";
import type { Library, Memory } from "./memory-app.js";
import { memoryDatabaseAvailable, useMemoryApp } from "./memory-app.js";

describe.skipIf(!memoryDatabaseAvailable)("governed memory API journeys", () => {
  const app = useMemoryApp("memory-library", () => import("../../../apps/api/src/app.ts"));
  const { raw, rpc, signup, join } = app;

  it("publishes only the reviewed text, survives source-bot deletion, and revokes a former member", async () => {
    const owner = await signup("Memory Owner");
    const colleague = await signup("Memory Colleague");
    const outsider = await signup("Memory Outsider");
    const dedicated = await rpc<{ id: string }>(owner, "spaces/create", {
      name: "Memory sharing fixture",
    });
    owner.actor.spaceId = dedicated.id;
    await join(colleague.actor.userId, owner.actor.spaceId);
    const bot = await rpc<{ id: string }>(owner, "bots/create", {
      name: "Memory Fixture",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const source = await rpc<Memory>(owner, "memory/library/create", {
      collection: "agent",
      botId: bot.id,
      title: "Private planning note",
      content: "Private-only fixture detail.\n\nThe pilot needs an invitation check.",
      qualification: { subjects: ["Private-only fixture subject"] },
      idempotencyKey: randomUUID(),
    });
    const publish = {
      documentId: source.id,
      expectedRevision: source.revision,
      title: "Invitation check",
      content: "## Invitation check\n\n- [ ] Verify an expired invitation.",
      includeSourceExcerpt: false,
      idempotencyKey: randomUUID(),
    };
    const published = await app.library.publish(owner.actor, publish);
    const repeated = await app.library.publish(owner.actor, publish);
    expect(repeated.id).toBe(published.id);
    expect(published.id).not.toBe(source.id);
    const visible = await rpc<Memory>(
      colleague,
      "memory/library/get",
      { documentId: published.id },
      owner.actor.spaceId,
    );
    expect(visible.content).toBe(publish.content);
    expect(visible.canEdit).toBe(false);
    expect(visible.canWithdraw).toBe(false);
    expect(JSON.stringify(visible)).not.toContain("Private-only");
    expect(JSON.stringify(visible)).not.toContain(source.id);
    const listing = await rpc<Library>(
      colleague,
      "memory/library/list",
      { query: "Private-only" },
      owner.actor.spaceId,
    );
    expect(listing.items).toHaveLength(0);
    const privateResponse = await raw(
      colleague,
      "memory/library/get",
      { documentId: source.id },
      owner.actor.spaceId,
    );
    expect([403, 404]).toContain(privateResponse.status);
    const privateBody = await privateResponse.text();
    expect(privateBody).not.toContain(source.content);
    const outsideResponse = await raw(
      outsider,
      "memory/library/get",
      { documentId: published.id },
      owner.actor.spaceId,
    );
    expect([401, 403, 404]).toContain(outsideResponse.status);

    await rpc(owner, "bots/remove", { botId: bot.id, deleteMemories: true });
    const surviving = await rpc<Memory>(
      colleague,
      "memory/library/get",
      { documentId: published.id },
      owner.actor.spaceId,
    );
    expect(surviving.content).toBe(publish.content);
    expect(
      JSON.stringify(
        await rpc(
          colleague,
          "memory/library/history",
          { documentId: published.id },
          owner.actor.spaceId,
        ),
      ),
    ).not.toContain("Private-only");

    await app.handles.prisma.spaceMember.delete({
      where: { spaceId_userId: { spaceId: owner.actor.spaceId, userId: colleague.actor.userId } },
    });
    const revoked = await raw(
      colleague,
      "memory/library/get",
      { documentId: published.id },
      owner.actor.spaceId,
    );
    expect([401, 403, 404]).toContain(revoked.status);
  });

  it("captures an authorized message as active evidence and round-trips legacy and OKF qualification", async () => {
    const owner = await signup("Memory Capture Fixture");
    const project = await rpc<Memory>(owner, "memory/library/create", {
      collection: "personal",
      content: "Project entity fixture.",
      qualification: { profileVersion: "okf-tolaria/0.1", documentType: "Project" },
      idempotencyKey: randomUUID(),
    });
    const linked = await rpc<Memory & { qualification: Record<string, unknown> }>(
      owner,
      "memory/library/create",
      {
        collection: "personal",
        content: "Linked observation.",
        qualification: {
          entityRefs: [{ kind: "project", documentId: project.id }],
        },
        idempotencyKey: randomUUID(),
      },
    );
    expect(linked.qualification.entityRefs).toEqual([{ kind: "project", documentId: project.id }]);
    const crossAudienceLink = await raw(owner, "memory/library/create", {
      collection: "space",
      content: "This cannot disclose a personal target.",
      qualification: { entityRefs: [{ kind: "project", documentId: project.id }] },
    });
    expect(crossAudienceLink.status).toBe(404);
    const bot = await rpc<{ id: string; threadId: string }>(owner, "bots/create", {
      name: "Capture Fixture",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const thread = await app.handles.prisma.thread.findUniqueOrThrow({
      where: { id: bot.threadId },
      select: { sessionId: true },
    });
    const sessionLog = new PostgresSessionLog(app.handles.prisma);
    const logged = (draft: Pick<SessionEntryDraft, "type" | "payload" | "botId">) =>
      app.handles.prisma.$transaction((tx) =>
        sessionLog.append(tx, {
          ...draft,
          sessionId: thread.sessionId as SessionId,
          feedBotId: bot.id,
        } as SessionEntryDraft),
      );
    const message = await logged({
      type: "user.message",
      payload: {
        blocks: [{ kind: "text", text: "Keep this exact source passage." }],
        source: "app",
      },
    });
    const captured = await rpc<
      Memory & { evidence: Array<Record<string, unknown>>; qualification: Record<string, unknown> }
    >(owner, "memory/library/capture", {
      messageId: message.id,
      title: "Capture proof",
      idempotencyKey: randomUUID(),
      qualification: {
        profileVersion: "okf-tolaria/0.1",
        documentType: "Memory",
        nature: "decision",
        entityRefs: [],
        kind: "decision",
        subjects: ["continuity"],
        impact: "important",
        objective: { label: "Legacy field stays intact", keyResult: "No conversion" },
      },
    });
    expect(captured.status).toBe("active");
    expect(captured.content).toBe("Keep this exact source passage.");
    expect(captured.evidence).toHaveLength(1);
    expect(captured.evidence[0]).toMatchObject({
      sourceKind: "message",
      sourceReferenceId: message.id,
      status: "verified",
      startOffset: 0,
      endOffset: 31,
      excerpt: "Keep this exact source passage.",
    });
    expect(captured.qualification).toEqual({
      profileVersion: "okf-tolaria/0.1",
      documentType: "Memory",
      nature: "decision",
      entityRefs: [],
      kind: "decision",
      subjects: ["continuity"],
      impact: "important",
      objective: { label: "Legacy field stays intact", keyResult: "No conversion" },
    });
    const assistantMessage = await logged({
      type: "bot.text",
      botId: bot.id,
      payload: { blocks: [{ kind: "text", text: "A response worth keeping." }] },
    });
    const assistantCapture = await rpc<Memory & { evidence: Array<Record<string, unknown>> }>(
      owner,
      "memory/library/capture",
      { messageId: assistantMessage.id },
    );
    expect(assistantCapture.evidence[0]).toMatchObject({
      sourceRole: "assistant",
      sourceReferenceId: assistantMessage.id,
      status: "verified",
    });
    await app.handles.prisma.sessionEntry.delete({ where: { id: message.id } });
    const afterRevocation = await rpc<
      Memory & { evidence: Array<Record<string, unknown>>; qualification: Record<string, unknown> }
    >(owner, "memory/library/get", { documentId: captured.id });
    expect(afterRevocation.evidence[0]).toMatchObject({
      sourceKind: "message",
      sourceReferenceId: null,
      sourceVersion: null,
      status: "missing",
      excerpt: null,
    });
  });

  it("rejects a stale save and never restores a withdrawn memory merely by editing it", async () => {
    const owner = await signup("Memory Revision Fixture");
    const original = await rpc<Memory>(owner, "memory/library/create", {
      collection: "personal",
      content: "## Original\n\nKeep **Markdown** exactly.",
      idempotencyKey: randomUUID(),
    });
    const updated = await app.library.update(owner.actor, {
      documentId: original.id,
      expectedRevision: original.revision,
      content: "## Corrected\n\nKeep **Markdown** exactly.\n",
    });
    await expect(
      app.library.update(owner.actor, {
        documentId: original.id,
        expectedRevision: original.revision,
        content: "This stale edit must not win.",
      }),
    ).rejects.toBeInstanceOf(MemoryConflictError);
    expect(
      (await rpc<Memory>(owner, "memory/library/get", { documentId: original.id })).content,
    ).toBe(updated.content);
    const withdrawn = await app.library.withdraw(owner.actor, updated.id, updated.revision);
    expect(withdrawn.status).toBe("withdrawn");
    const edited = await app.library.update(owner.actor, {
      documentId: withdrawn.id,
      expectedRevision: withdrawn.revision,
      content: "Corrected while withdrawn.",
    });
    expect(edited.status).toBe("withdrawn");
    const active = await rpc<Library>(owner, "memory/library/list", { status: "active" });
    expect(active.items.map((item) => item.id)).not.toContain(edited.id);
    const restored = await app.library.restore(owner.actor, edited.id, edited.revision);
    expect(restored.status).toBe("active");
    expect(restored.content).toBe(edited.content);
    const history = JSON.stringify(
      await rpc(owner, "memory/library/history", { documentId: original.id }),
    );
    expect(history).toContain("Keep **Markdown** exactly.");
    expect(history).not.toContain("This stale edit must not win.");
  });

  it("paginates without dropping memories and keeps retry identity tied to the full command", async () => {
    const owner = await signup("Memory Pagination Fixture");
    const marker = `Pagination ${randomUUID()}`;
    const created: Memory[] = [];
    for (let index = 0; index < 5; index++) {
      created.push(
        await rpc<Memory>(owner, "memory/library/create", {
          collection: "personal",
          title: `${marker} ${index}`,
          content: `Entry ${index}.`,
          idempotencyKey: randomUUID(),
        }),
      );
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const response = await rpc<Library>(owner, "memory/library/list", {
        collection: "personal",
        query: marker,
        limit: 2,
        cursor,
      });
      seen.push(...response.items.map((item) => item.id));
      if (!response.nextCursor) break;
      cursor = response.nextCursor;
    }
    expect(seen).toHaveLength(created.length);
    expect(new Set(seen)).toEqual(new Set(created.map((document) => document.id)));
    const command = {
      collection: "personal",
      title: "Retry fixture",
      content: "Retry once.",
      idempotencyKey: randomUUID(),
    };
    const duplicates = await Promise.all([
      rpc<Memory>(owner, "memory/library/create", command),
      rpc<Memory>(owner, "memory/library/create", command),
    ]);
    expect(duplicates[0]!.id).toBe(duplicates[1]!.id);
    const differentAudience = await raw(owner, "memory/library/create", {
      ...command,
      collection: "space",
    });
    expect(differentAudience.status).toBe(409);
    const differentClassification = await raw(owner, "memory/library/create", {
      ...command,
      qualification: { subjects: ["Different classification"] },
    });
    expect(differentClassification.status).toBe(409);
  });

  it("replaces only the two reviewed revisions and rolls back a stale replacement", async () => {
    const owner = await signup("Replacement Fixture");
    const previous = await rpc<Memory>(owner, "memory/library/create", {
      collection: "personal",
      content: "Old policy.",
    });
    const replacement = await rpc<Memory>(owner, "memory/library/create", {
      collection: "personal",
      content: "New policy.",
    });
    const newerPrevious = await app.library.update(owner.actor, {
      documentId: previous.id,
      expectedRevision: previous.revision,
      content: "Old policy with an exception.",
    });
    await expect(
      app.library.update(owner.actor, {
        documentId: replacement.id,
        expectedRevision: replacement.revision,
        content: "An edit that must roll back.",
        replaceDocumentId: previous.id,
        replacedExpectedRevision: previous.revision,
      }),
    ).rejects.toBeInstanceOf(MemoryConflictError);
    expect(
      await rpc<Memory>(owner, "memory/library/get", { documentId: replacement.id }),
    ).toMatchObject({
      revision: replacement.revision,
      content: replacement.content,
    });
    expect(
      (await rpc<Memory>(owner, "memory/library/get", { documentId: previous.id })).status,
    ).toBe("active");
    await app.library.update(owner.actor, {
      documentId: replacement.id,
      expectedRevision: replacement.revision,
      replaceDocumentId: previous.id,
      replacedExpectedRevision: newerPrevious.revision,
    });
    const retired = await rpc<Memory>(owner, "memory/library/get", { documentId: previous.id });
    expect(retired).toMatchObject({ status: "superseded", revision: newerPrevious.revision + 1 });
    const history = await rpc<Memory[]>(owner, "memory/library/history", {
      documentId: previous.id,
    });
    expect(history[0]).toMatchObject({ status: "superseded", content: newerPrevious.content });
    expect(history[1]).toMatchObject({ status: "active", content: newerPrevious.content });
  });
});
