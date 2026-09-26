import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { sessionCookieHeader } from "./index.js";

type AppHandles = Awaited<ReturnType<typeof createApp>>;
type Memory = {
  id: string;
  title: string;
  content: string;
  revision: number;
  status: string;
  canEdit: boolean;
  canWithdraw: boolean;
};
type Library = { items: Array<Omit<Memory, "content">>; nextCursor?: string | null };
type Member = { cookie: string; actor: Actor };

const available = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";

describe.skipIf(!available)("governed memory API journeys", () => {
  let handles: AppHandles;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-memory-library-"));
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
    });
  });

  afterAll(async () => {
    await handles?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  async function raw(
    member: Member,
    procedure: string,
    input: unknown,
    spaceId = member.actor.spaceId,
  ) {
    return handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: member.cookie,
        origin,
        "x-rakazo-space-id": spaceId,
      },
      body: JSON.stringify({ json: input }),
    });
  }

  async function rpc<T>(
    member: Member,
    procedure: string,
    input: unknown,
    spaceId = member.actor.spaceId,
  ): Promise<T> {
    const response = await raw(member, procedure, input, spaceId);
    const body = await response.json();
    expect(response.status, `${procedure}: ${JSON.stringify(body)}`).toBeLessThan(400);
    return body.json;
  }

  async function signup(name: string): Promise<Member> {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `memory-${randomUUID()}@rakazo.test`,
        password: "password12",
        name,
      }),
    });
    expect(response.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(response);
    const me = await handles.app.request("/rpc/me", {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ json: {} }),
    });
    expect(me.status).toBe(200);
    return { cookie, actor: (await me.json()).json };
  }

  async function join(member: Member, owner: Member) {
    const space = await handles.prisma.space.findUniqueOrThrow({
      where: { id: owner.actor.spaceId },
      select: { organizationId: true },
    });
    await handles.prisma.member.upsert({
      where: {
        organizationId_userId: {
          organizationId: space.organizationId,
          userId: member.actor.userId,
        },
      },
      update: {},
      create: {
        id: randomUUID(),
        organizationId: space.organizationId,
        userId: member.actor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await handles.prisma.spaceMember.upsert({
      where: { spaceId_userId: { spaceId: owner.actor.spaceId, userId: member.actor.userId } },
      update: { role: "member" },
      create: {
        id: randomUUID(),
        organizationId: space.organizationId,
        spaceId: owner.actor.spaceId,
        userId: member.actor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
  }

  it("publishes only the reviewed text, survives source-bot deletion, and revokes a former member", async () => {
    const owner = await signup("Memory Owner");
    const colleague = await signup("Memory Colleague");
    const outsider = await signup("Memory Outsider");
    const dedicated = await rpc<{ id: string }>(owner, "spaces/create", {
      name: "Memory sharing fixture",
    });
    owner.actor.spaceId = dedicated.id;
    await join(colleague, owner);
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
    const published = await rpc<Memory>(owner, "memory/library/publish", publish);
    const repeated = await rpc<Memory>(owner, "memory/library/publish", publish);
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

    await handles.prisma.spaceMember.delete({
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
    const thread = await handles.prisma.thread.findUniqueOrThrow({
      where: { id: bot.threadId },
      select: { nextMessageSeq: true },
    });
    const message = await handles.prisma.message.create({
      data: {
        threadId: bot.threadId,
        seq: thread.nextMessageSeq,
        role: "user",
        blocks: [{ kind: "text", text: "Keep this exact source passage." }],
      },
    });
    await handles.prisma.thread.update({
      where: { id: bot.threadId },
      data: { nextMessageSeq: { increment: 1 } },
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
    const assistantMessage = await handles.prisma.message.create({
      data: {
        threadId: bot.threadId,
        seq: thread.nextMessageSeq + 1,
        role: "bot",
        blocks: [{ kind: "text", text: "A response worth keeping." }],
      },
    });
    await handles.prisma.thread.update({
      where: { id: bot.threadId },
      data: { nextMessageSeq: { increment: 1 } },
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
    await handles.prisma.message.delete({ where: { id: message.id } });
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
    const updated = await rpc<Memory>(owner, "memory/library/update", {
      documentId: original.id,
      expectedRevision: original.revision,
      content: "## Corrected\n\nKeep **Markdown** exactly.\n",
    });
    const stale = await raw(owner, "memory/library/update", {
      documentId: original.id,
      expectedRevision: original.revision,
      content: "This stale edit must not win.",
    });
    expect(stale.status).toBe(409);
    expect(
      (await rpc<Memory>(owner, "memory/library/get", { documentId: original.id })).content,
    ).toBe(updated.content);
    const withdrawn = await rpc<Memory>(owner, "memory/library/withdraw", {
      documentId: updated.id,
      expectedRevision: updated.revision,
    });
    expect(withdrawn.status).toBe("withdrawn");
    const edited = await rpc<Memory>(owner, "memory/library/update", {
      documentId: withdrawn.id,
      expectedRevision: withdrawn.revision,
      content: "Corrected while withdrawn.",
    });
    expect(edited.status).toBe("withdrawn");
    const active = await rpc<Library>(owner, "memory/library/list", { status: "active" });
    expect(active.items.map((item) => item.id)).not.toContain(edited.id);
    const restored = await rpc<Memory>(owner, "memory/library/restore", {
      documentId: edited.id,
      expectedRevision: edited.revision,
    });
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
    const newerPrevious = await rpc<Memory>(owner, "memory/library/update", {
      documentId: previous.id,
      expectedRevision: previous.revision,
      content: "Old policy with an exception.",
    });
    const stale = await raw(owner, "memory/library/update", {
      documentId: replacement.id,
      expectedRevision: replacement.revision,
      content: "An edit that must roll back.",
      replaceDocumentId: previous.id,
      replacedExpectedRevision: previous.revision,
    });
    expect(stale.status).toBe(409);
    expect(
      await rpc<Memory>(owner, "memory/library/get", { documentId: replacement.id }),
    ).toMatchObject({
      revision: replacement.revision,
      content: replacement.content,
    });
    expect(
      (await rpc<Memory>(owner, "memory/library/get", { documentId: previous.id })).status,
    ).toBe("active");
    await rpc<Memory>(owner, "memory/library/update", {
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

  it("imports inert OKF and consolidates only current same-collection sources", async () => {
    const owner = await signup("Memory Workflow Fixture");
    const first = await rpc<Memory>(owner, "memory/library/create", {
      collection: "personal",
      content: "A memory about invitation expiry and the recovery path.",
      idempotencyKey: randomUUID(),
    });
    const second = await rpc<Memory>(owner, "memory/library/create", {
      collection: "personal",
      content: "A memory about invitation expiry and the recovery path.",
      idempotencyKey: randomUUID(),
    });
    expect((await rpc<Memory>(owner, "memory/library/get", { documentId: second.id })).status).toBe(
      "active",
    );

    const imported = await rpc<Memory & { qualification: Record<string, unknown> }>(
      owner,
      "memory/library/importOkf",
      {
        collection: "personal",
        content: [
          "---",
          "type: Memory",
          "profile: okf-tolaria/0.1",
          "status: active",
          "audience: space",
          "extensions:",
          "  approved: true",
          "---",
          "# Imported proposal",
          "",
          "Retain the Markdown body.",
          "",
        ].join("\n"),
        idempotencyKey: randomUUID(),
      },
    );
    expect(imported.status).toBe("proposed");
    expect(imported.content).toBe("# Imported proposal\n\nRetain the Markdown body.\n");
    expect(imported.qualification.unknownMetadata).toMatchObject({
      status: "active",
      audience: "space",
      approved: true,
    });
    const exported = await rpc<string>(owner, "memory/library/exportOkf", {
      documentId: imported.id,
      expectedRevision: imported.revision,
    });
    expect(exported).toContain("profile: okf-tolaria/0.1");
    expect(exported).toContain("Retain the Markdown body.");
    expect(exported).toContain("status: active");

    const proposed = await rpc<
      Memory & { evidence: Array<{ sourceReferenceId: string; status: string }> }
    >(owner, "memory/library/proposeConsolidation", {
      sources: [
        { documentId: first.id, revision: first.revision },
        { documentId: second.id, revision: second.revision },
      ],
      content: "The reviewed summary of the invitation recovery policy.",
      title: "Invitation recovery",
      idempotencyKey: randomUUID(),
    });
    expect(proposed.status).toBe("proposed");
    expect(proposed.evidence).toHaveLength(2);
    expect(proposed.evidence.every((proof) => proof.status === "verified")).toBe(true);
    const reviewedProposal = await rpc<Memory & { evidence: Array<{ status: string }> }>(
      owner,
      "memory/library/update",
      {
        documentId: proposed.id,
        expectedRevision: proposed.revision,
        title: "Invitation recovery reviewed",
        content:
          "The human-reviewed summary keeps the exception: invitation recovery follows the expiry check.",
      },
    );
    expect(reviewedProposal.evidence).toHaveLength(2);
    expect(reviewedProposal.evidence.every((proof) => proof.status === "verified")).toBe(true);
    const accepted = await rpc<Memory>(owner, "memory/library/acceptConsolidation", {
      documentId: reviewedProposal.id,
      expectedRevision: reviewedProposal.revision,
      replaceSources: false,
    });
    expect(accepted.status).toBe("active");
    expect((await rpc<Memory>(owner, "memory/library/get", { documentId: first.id })).status).toBe(
      "active",
    );
    const store = new MarkdownMemoryStore(handles.prisma);
    const recalled = await store.read(
      { scope: "user" },
      {
        operationId: randomUUID(),
        traceId: randomUUID(),
        spaceId: owner.actor.spaceId,
        userId: owner.actor.userId,
        signal: new AbortController().signal,
      },
    );
    expect(recalled.documents.map((item) => item.id)).toContain(proposed.id);

    const staleProposal = await rpc<Memory>(owner, "memory/library/proposeConsolidation", {
      sources: [
        { documentId: first.id, revision: first.revision },
        { documentId: second.id, revision: second.revision },
      ],
      content: "This proposal is based on exact source revisions.",
      idempotencyKey: randomUUID(),
    });
    const editedSource = await rpc<Memory>(owner, "memory/library/update", {
      documentId: first.id,
      expectedRevision: first.revision,
      content: "The source has since changed.",
    });
    expect(editedSource.revision).toBeGreaterThan(first.revision);
    const staleAcceptance = await raw(owner, "memory/library/acceptConsolidation", {
      documentId: staleProposal.id,
      expectedRevision: staleProposal.revision,
      replaceSources: false,
    });
    expect(staleAcceptance.status).toBe(409);

    const replaceLeft = await rpc<Memory>(owner, "memory/library/create", {
      collection: "personal",
      content: "Replaceable source left.",
      idempotencyKey: randomUUID(),
    });
    const replaceRight = await rpc<Memory>(owner, "memory/library/create", {
      collection: "personal",
      content: "Replaceable source right.",
      idempotencyKey: randomUUID(),
    });
    const replacementProposal = await rpc<Memory>(owner, "memory/library/proposeConsolidation", {
      sources: [
        { documentId: replaceLeft.id, revision: replaceLeft.revision },
        { documentId: replaceRight.id, revision: replaceRight.revision },
      ],
      content: "A consolidation that explicitly replaces both sources.",
      idempotencyKey: randomUUID(),
    });
    const replacement = await rpc<Memory>(owner, "memory/library/acceptConsolidation", {
      documentId: replacementProposal.id,
      expectedRevision: replacementProposal.revision,
      replaceSources: true,
    });
    expect(replacement.status).toBe("active");
    expect(
      (await rpc<Memory>(owner, "memory/library/get", { documentId: replaceLeft.id })).status,
    ).toBe("superseded");
    const afterReplacement = await store.read(
      { scope: "user" },
      {
        operationId: randomUUID(),
        traceId: randomUUID(),
        spaceId: owner.actor.spaceId,
        userId: owner.actor.userId,
        signal: new AbortController().signal,
      },
    );
    expect(afterReplacement.documents.map((item) => item.id)).toContain(replacement.id);
    const editedReplacement = await rpc<Memory & { evidence: Array<{ status: string }> }>(
      owner,
      "memory/library/update",
      {
        documentId: replacement.id,
        expectedRevision: replacement.revision,
        content: "The accepted consolidation, edited after explicitly replacing both sources.",
      },
    );
    expect(editedReplacement.evidence).toHaveLength(2);
    const afterEditedReplacement = await store.read(
      { scope: "user" },
      {
        operationId: randomUUID(),
        traceId: randomUUID(),
        spaceId: owner.actor.spaceId,
        userId: owner.actor.userId,
        signal: new AbortController().signal,
      },
    );
    expect(afterEditedReplacement.documents.map((item) => item.id)).toContain(replacement.id);
    await rpc<Memory>(owner, "memory/library/withdraw", {
      documentId: replaceLeft.id,
      expectedRevision: replaceLeft.revision + 1,
    });
    const afterRevocation = await store.read(
      { scope: "user" },
      {
        operationId: randomUUID(),
        traceId: randomUUID(),
        spaceId: owner.actor.spaceId,
        userId: owner.actor.userId,
        signal: new AbortController().signal,
      },
    );
    expect(afterRevocation.documents.map((item) => item.id)).not.toContain(replacement.id);

    const nestedSource = await rpc<Memory>(owner, "memory/library/create", {
      collection: "personal",
      content: "Nested source that will be withdrawn.",
      idempotencyKey: randomUUID(),
    });
    const nestedSupport = await rpc<Memory>(owner, "memory/library/create", {
      collection: "personal",
      content: "Supporting evidence for the nested synthesis.",
      idempotencyKey: randomUUID(),
    });
    const downstreamSupport = await rpc<Memory>(owner, "memory/library/create", {
      collection: "personal",
      content: "Independent support for the later synthesis.",
      idempotencyKey: randomUUID(),
    });
    const firstSynthesis = await rpc<Memory>(owner, "memory/library/proposeConsolidation", {
      sources: [
        { documentId: nestedSource.id, revision: nestedSource.revision },
        { documentId: nestedSupport.id, revision: nestedSupport.revision },
      ],
      content: "First synthesis with two sources.",
      idempotencyKey: randomUUID(),
    });
    const activeFirstSynthesis = await rpc<Memory>(owner, "memory/library/acceptConsolidation", {
      documentId: firstSynthesis.id,
      expectedRevision: firstSynthesis.revision,
      replaceSources: false,
    });
    const secondSynthesis = await rpc<Memory>(owner, "memory/library/proposeConsolidation", {
      sources: [
        { documentId: activeFirstSynthesis.id, revision: activeFirstSynthesis.revision },
        { documentId: downstreamSupport.id, revision: downstreamSupport.revision },
      ],
      content: "Second synthesis depends on the first.",
      idempotencyKey: randomUUID(),
    });
    const activeSecondSynthesis = await rpc<Memory>(owner, "memory/library/acceptConsolidation", {
      documentId: secondSynthesis.id,
      expectedRevision: secondSynthesis.revision,
      replaceSources: false,
    });
    const beforeDeepRevocation = await store.read(
      { scope: "user" },
      {
        operationId: randomUUID(),
        traceId: randomUUID(),
        spaceId: owner.actor.spaceId,
        userId: owner.actor.userId,
        signal: new AbortController().signal,
      },
    );
    expect(beforeDeepRevocation.documents.map((item) => item.id)).toContain(
      activeFirstSynthesis.id,
    );
    expect(beforeDeepRevocation.documents.map((item) => item.id)).toContain(
      activeSecondSynthesis.id,
    );
    await rpc<Memory>(owner, "memory/library/withdraw", {
      documentId: nestedSource.id,
      expectedRevision: nestedSource.revision,
    });
    const afterDeepRevocation = await store.read(
      { scope: "user" },
      {
        operationId: randomUUID(),
        traceId: randomUUID(),
        spaceId: owner.actor.spaceId,
        userId: owner.actor.userId,
        signal: new AbortController().signal,
      },
    );
    expect(afterDeepRevocation.documents.map((item) => item.id)).not.toContain(
      activeFirstSynthesis.id,
    );
    expect(afterDeepRevocation.documents.map((item) => item.id)).not.toContain(
      activeSecondSynthesis.id,
    );
  });

  it("keeps private export and cross-audience sources inaccessible to a space colleague", async () => {
    const owner = await signup("Memory Private Export Owner");
    const colleague = await signup("Memory Private Export Colleague");
    const space = await rpc<{ id: string }>(owner, "spaces/create", {
      name: "Private export fixture",
    });
    owner.actor.spaceId = space.id;
    colleague.actor.spaceId = space.id;
    await join(colleague, owner);
    const privateDocument = await rpc<Memory>(owner, "memory/library/create", {
      collection: "personal",
      content: "Private export fixture payload.",
      idempotencyKey: randomUUID(),
    });
    const deniedExport = await raw(colleague, "memory/library/exportOkf", {
      documentId: privateDocument.id,
      expectedRevision: privateDocument.revision,
    });
    expect([403, 404]).toContain(deniedExport.status);
    expect(await deniedExport.text()).not.toContain("Private export fixture payload.");
    const colleagueSource = await rpc<Memory>(colleague, "memory/library/create", {
      collection: "personal",
      content: "Colleague private source.",
      idempotencyKey: randomUUID(),
    });
    const crossAudienceProposal = await raw(owner, "memory/library/proposeConsolidation", {
      sources: [
        { documentId: privateDocument.id, revision: privateDocument.revision },
        { documentId: colleagueSource.id, revision: colleagueSource.revision },
      ],
      content: "This must not join audiences.",
    });
    expect([403, 404]).toContain(crossAudienceProposal.status);
  });
});
