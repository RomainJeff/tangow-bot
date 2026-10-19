import { randomUUID } from "node:crypto";
import { MarkdownMemoryStore, MemoryAccessError, MemoryConflictError } from "@rakazo/memory";
import { describe, expect, it } from "vitest";
import type { Memory } from "./memory-app.js";
import { memoryDatabaseAvailable, useMemoryApp } from "./memory-app.js";

describe.skipIf(!memoryDatabaseAvailable)("memory import, consolidation and audience", () => {
  const app = useMemoryApp("memory-consolidation", () => import("../../../apps/api/src/app.ts"));
  const { rpc, signup, join } = app;

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

    const imported = await app.library.importOkf(owner.actor, {
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
    });
    expect(imported.status).toBe("proposed");
    expect(imported.content).toBe("# Imported proposal\n\nRetain the Markdown body.\n");
    expect(imported.qualification.unknownMetadata).toMatchObject({
      status: "active",
      audience: "space",
      approved: true,
    });

    const proposed = await app.library.proposeConsolidation(owner.actor, {
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
    const reviewedProposal = await app.library.update(owner.actor, {
      documentId: proposed.id,
      expectedRevision: proposed.revision,
      title: "Invitation recovery reviewed",
      content:
        "The human-reviewed summary keeps the exception: invitation recovery follows the expiry check.",
    });
    expect(reviewedProposal.evidence).toHaveLength(2);
    expect(reviewedProposal.evidence.every((proof) => proof.status === "verified")).toBe(true);
    const accepted = await app.library.acceptConsolidation(
      owner.actor,
      reviewedProposal.id,
      reviewedProposal.revision,
      false,
    );
    expect(accepted.status).toBe("active");
    expect((await rpc<Memory>(owner, "memory/library/get", { documentId: first.id })).status).toBe(
      "active",
    );
    const store = new MarkdownMemoryStore(app.handles.prisma);
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

    const staleProposal = await app.library.proposeConsolidation(owner.actor, {
      sources: [
        { documentId: first.id, revision: first.revision },
        { documentId: second.id, revision: second.revision },
      ],
      content: "This proposal is based on exact source revisions.",
      idempotencyKey: randomUUID(),
    });
    const editedSource = await app.library.update(owner.actor, {
      documentId: first.id,
      expectedRevision: first.revision,
      content: "The source has since changed.",
    });
    expect(editedSource.revision).toBeGreaterThan(first.revision);
    await expect(
      app.library.acceptConsolidation(owner.actor, staleProposal.id, staleProposal.revision, false),
    ).rejects.toBeInstanceOf(MemoryConflictError);

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
    const replacementProposal = await app.library.proposeConsolidation(owner.actor, {
      sources: [
        { documentId: replaceLeft.id, revision: replaceLeft.revision },
        { documentId: replaceRight.id, revision: replaceRight.revision },
      ],
      content: "A consolidation that explicitly replaces both sources.",
      idempotencyKey: randomUUID(),
    });
    const replacement = await app.library.acceptConsolidation(
      owner.actor,
      replacementProposal.id,
      replacementProposal.revision,
      true,
    );
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
    const editedReplacement = await app.library.update(owner.actor, {
      documentId: replacement.id,
      expectedRevision: replacement.revision,
      content: "The accepted consolidation, edited after explicitly replacing both sources.",
    });
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
    await app.library.withdraw(owner.actor, replaceLeft.id, replaceLeft.revision + 1);
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
    const firstSynthesis = await app.library.proposeConsolidation(owner.actor, {
      sources: [
        { documentId: nestedSource.id, revision: nestedSource.revision },
        { documentId: nestedSupport.id, revision: nestedSupport.revision },
      ],
      content: "First synthesis with two sources.",
      idempotencyKey: randomUUID(),
    });
    const activeFirstSynthesis = await app.library.acceptConsolidation(
      owner.actor,
      firstSynthesis.id,
      firstSynthesis.revision,
      false,
    );
    const secondSynthesis = await app.library.proposeConsolidation(owner.actor, {
      sources: [
        { documentId: activeFirstSynthesis.id, revision: activeFirstSynthesis.revision },
        { documentId: downstreamSupport.id, revision: downstreamSupport.revision },
      ],
      content: "Second synthesis depends on the first.",
      idempotencyKey: randomUUID(),
    });
    const activeSecondSynthesis = await app.library.acceptConsolidation(
      owner.actor,
      secondSynthesis.id,
      secondSynthesis.revision,
      false,
    );
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
    await app.library.withdraw(owner.actor, nestedSource.id, nestedSource.revision);
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
    await join(colleague.actor.userId, owner.actor.spaceId);
    const privateDocument = await rpc<Memory>(owner, "memory/library/create", {
      collection: "personal",
      content: "Private export fixture payload.",
      idempotencyKey: randomUUID(),
    });
    await expect(app.library.get(colleague.actor, privateDocument.id)).rejects.toBeInstanceOf(
      MemoryAccessError,
    );
    const colleagueSource = await rpc<Memory>(colleague, "memory/library/create", {
      collection: "personal",
      content: "Colleague private source.",
      idempotencyKey: randomUUID(),
    });
    await expect(
      app.library.proposeConsolidation(owner.actor, {
        sources: [
          { documentId: privateDocument.id, revision: privateDocument.revision },
          { documentId: colleagueSource.id, revision: colleagueSource.revision },
        ],
        content: "This must not join audiences.",
      }),
    ).rejects.toBeInstanceOf(MemoryAccessError);
  });
});
