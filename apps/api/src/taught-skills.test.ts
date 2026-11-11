import type * as db from "@tangow/db";
import { expect, it, vi } from "vitest";
import type { TaughtSkillsDeps } from "./taught-skills.js";
import { createTaughtSkillsService } from "./taught-skills.js";

const logged = vi.hoisted(() => [] as unknown[]);
vi.mock("@tangow/db", async (original) => ({
  ...(await original<typeof db>()),
  appendCardStateInTransaction: vi.fn(async (_tx, draft) => {
    logged.push(draft);
  }),
  threadEventSeq: vi.fn(async () => 1),
}));

const playbook = {
  whenToUse: "A new invoice arrives",
  inputs: ["the invoice"],
  steps: ["Open the invoice", "File it"],
  howToCheck: "It is in the folder",
  whatToReturn: "The file name",
  approvalBoundaries: "Never pay",
  failureHandling: "Ask",
};

it("logs each revision of a taught skill's draft card against the card", async () => {
  const draft = {
    kind: "skill_draft",
    skillId: "skill-1",
    name: "File invoices",
    goal: "File invoices",
    playbook: { ...playbook, steps: [] },
    status: "draft",
  };
  const skill = {
    id: "skill-1",
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    name: "File invoices",
    goal: "File invoices",
    status: "draft",
    playbook,
    recording: null,
    startedAt: null,
    expiresAt: null,
    stoppedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    sessionEntry: {
      findFirst: vi
        .fn()
        // The draft card, then no revision logged against it yet.
        .mockResolvedValueOnce({ id: "card-1", payload: { blocks: [draft] } })
        .mockResolvedValueOnce(null),
    },
  };
  const deps = {
    prisma: {
      taughtSkill: {
        findFirst: vi.fn(async () => skill),
        update: vi.fn(async ({ data }: { data: object }) => ({ ...skill, ...data })),
      },
      bot: {
        findUnique: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "thread-1", sessionId: "session-1" },
        })),
      },
      $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    },
    events: { notify: vi.fn(async () => undefined) },
  } as unknown as TaughtSkillsDeps;
  const actor = {
    userId: "user-1",
    spaceId: "space-1",
    email: "user@tangow.test",
    isDeploymentOwner: true,
  };

  await createTaughtSkillsService(deps).updateDraft(actor, "skill-1", {
    name: "File every invoice",
    playbook,
  });

  expect(logged).toEqual([
    {
      type: "skill.draft",
      botId: "bot-1",
      payload: {
        target: "card-1",
        skillId: "skill-1",
        name: "File every invoice",
        goal: "File invoices",
        playbook,
        status: "draft",
      },
    },
  ]);
});
