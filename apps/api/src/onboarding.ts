import type { ConnectorRegistry } from "@rakazo/adapters";
import type { Actor, MessageBlock, SessionEntryOf } from "@rakazo/contracts";
import { appConnectAnswerId, EntryId } from "@rakazo/contracts";
import { featuredConnectorProvidersMatch } from "@rakazo/core";
import {
  appendCardStateInTransaction,
  blocksOf,
  createBotMessageInTransaction,
  IsolationError,
  type Prisma,
  type PrismaClient,
  type ThreadEvents,
  threadEventSeq,
} from "@rakazo/db";

/**
 * First-run conversational onboarding, seeded deterministically into the bot's
 * thread: greeting, a focus choice, and available app cards the user authorizes
 * inline. Focus must not rename the bot. No model tokens are spent.
 */

type OnboardingDeps = {
  prisma: PrismaClient;
  events: ThreadEvents;
  connectors: ConnectorRegistry;
};

type FocusOption = {
  id: string;
  letter: string;
  label: string;
  summary: string;
  apps: string[];
};

const FOCUS_OPTIONS: FocusOption[] = [
  {
    id: "day",
    letter: "A",
    label: "Day-to-day work",
    summary: "Slack, calendar, and email",
    apps: ["slack", "gmail", "googlecalendar"],
  },
  {
    id: "inbox",
    letter: "B",
    label: "Inbox & email",
    summary: "email and calendar",
    apps: ["gmail", "googlecalendar", "slack"],
  },
  {
    id: "research",
    letter: "C",
    label: "Research & writing",
    summary: "the web, notes, and docs",
    apps: ["hackernews", "notion", "googledocs"],
  },
  {
    id: "everything",
    letter: "D",
    label: "A bit of everything",
    summary: "Slack, calendar, and email",
    apps: ["slack", "gmail", "googlecalendar"],
  },
];

const APP_DESCRIPTIONS: Record<string, string> = {
  slack: "Search, read, and send messages.",
  gmail: "Search, read, draft, and send email.",
  googlecalendar: "Search events and schedule meetings.",
  notion: "Search and edit pages and databases.",
  googledocs: "Draft and edit documents.",
  hackernews: "Search stories and discussions.",
};

async function requireBotThread(deps: OnboardingDeps, actor: Actor, botId: string) {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
    include: { thread: true },
  });
  if (!bot?.thread) throw new IsolationError();
  return { bot, thread: bot.thread };
}

type BotThreadTarget = { spaceId: string; botId: string; threadId: string; sessionId: string };

async function postInTransaction(
  tx: Prisma.TransactionClient,
  target: BotThreadTarget,
  blocks: MessageBlock[],
): Promise<number> {
  await createBotMessageInTransaction(tx, {
    threadId: target.threadId,
    botId: target.botId,
    blocks,
  });
  return threadEventSeq(tx, target.threadId);
}

async function post(
  deps: OnboardingDeps,
  target: BotThreadTarget,
  blocks: MessageBlock[],
): Promise<void> {
  const seq = await deps.prisma.$transaction((tx: Prisma.TransactionClient) =>
    postInTransaction(tx, target, blocks),
  );
  await deps.events.notify(target.threadId, seq);
}

type CardAnswer = Omit<SessionEntryOf<"card.answered">["payload"], "target">;
type AppConnectBlock = Extract<MessageBlock, { kind: "app_connect" }>;

/** The bot's cards in the thread holding a block of `kind`, oldest first, with their answers. */
async function cardsWith(
  db: PrismaClient | Prisma.TransactionClient,
  sessionId: string,
  kind: MessageBlock["kind"],
) {
  const cards = await db.sessionEntry.findMany({
    where: {
      sessionId,
      type: "bot.text",
      payload: { path: ["blocks"], array_contains: [{ kind }] },
    },
    orderBy: { seq: "asc" },
    select: { id: true, payload: true },
  });
  const answers = cards.length
    ? await db.sessionEntry.findMany({
        where: {
          sessionId,
          type: "card.answered",
          OR: cards.map((card) => ({ payload: { path: ["target"], equals: card.id } })),
        },
        select: { payload: true },
      })
    : [];
  return cards.map((card) => ({
    id: card.id,
    blocks: blocksOf(card),
    answers: answers
      .map((answer) => answer.payload as SessionEntryOf<"card.answered">["payload"])
      .filter((answer) => answer.target === card.id),
  }));
}

/**
 * Connects one card's matching apps under the thread lock, each once, as the answers logged right
 * now say.
 */
async function connectCards(
  deps: OnboardingDeps,
  target: BotThreadTarget,
  messageId: string,
  matches: (block: MessageBlock) => block is AppConnectBlock,
): Promise<void> {
  const seq = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const card = (await cardsWith(tx, target.sessionId, "app_connect")).find(
      (candidate) => candidate.id === messageId,
    );
    if (!card) return null;
    const answered = new Set(card.answers.map((answer) => answer.answerId));
    let connected = false;
    for (const block of card.blocks.filter(matches)) {
      const answerId = appConnectAnswerId(block);
      if (block.status === "connected" || answered.has(answerId)) continue;
      await answerCardInTransaction(tx, target, messageId, { answerId });
      connected = true;
    }
    return connected ? threadEventSeq(tx, target.threadId) : null;
  });
  if (seq !== null) await deps.events.notify(target.threadId, seq);
}

function answerCardInTransaction(
  tx: Prisma.TransactionClient,
  target: BotThreadTarget,
  messageId: string,
  answer: CardAnswer,
) {
  return appendCardStateInTransaction(tx, {
    type: "card.answered",
    botId: target.botId,
    payload: { target: EntryId.parse(messageId), ...answer },
  });
}

/** The focus card still waiting for a choice, under the thread lock. */
async function pendingFocus(tx: Prisma.TransactionClient, target: BotThreadTarget) {
  await tx.$executeRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
  return (await cardsWith(tx, target.sessionId, "choice")).find(
    (card) =>
      card.answers.length === 0 &&
      card.blocks.some((block) => block.kind === "choice" && !block.answerId),
  );
}

export async function startOnboarding(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
): Promise<void> {
  const { thread } = await requireBotThread(deps, actor, botId);
  const existing = await deps.prisma.sessionEntry.count({ where: { sessionId: thread.sessionId } });
  if (existing > 0) return;
  // Fresh chats start empty (same as web). The focus card is posted later via
  // promptFocus so non-first bots can wait ~10s for free typing, or skip if the
  // user already engaged.
}

export async function promptFocus(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
): Promise<void> {
  const { bot, thread } = await requireBotThread(deps, actor, botId);
  const target = {
    spaceId: actor.spaceId,
    botId: bot.id,
    threadId: thread.id,
    sessionId: thread.sessionId,
  };
  const blocks: MessageBlock[] = [
    {
      kind: "choice",
      question: "What do you want me on first?",
      options: FOCUS_OPTIONS.map(({ id, letter, label }) => ({ id, letter, label })),
    },
  ];
  // Check + insert + event in one transaction so concurrent promptFocus calls
  // cannot duplicate cards, and a concurrent user send cannot publish first.
  const committed = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Serialize concurrent promptFocus callers on this thread before the gate check.
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
    const engaged = await tx.sessionEntry.findFirst({
      where: { sessionId: thread.sessionId, type: "user.message" },
      select: { id: true },
    });
    if (engaged) return null;
    if ((await cardsWith(tx, thread.sessionId, "choice")).length > 0) return null;
    return postInTransaction(tx, target, blocks);
  });
  if (committed === null) return;
  await deps.events.notify(target.threadId, committed);
}

export async function dismissFocus(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
): Promise<void> {
  const { bot, thread } = await requireBotThread(deps, actor, botId);
  const target = {
    spaceId: actor.spaceId,
    botId: bot.id,
    threadId: thread.id,
    sessionId: thread.sessionId,
  };
  const claimed = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const pending = await pendingFocus(tx, target);
    if (!pending) return null;
    await answerCardInTransaction(tx, target, pending.id, { dismissed: true });
    return threadEventSeq(tx, target.threadId);
  });
  if (claimed === null) return;
  await deps.events.notify(target.threadId, claimed);
}

export async function chooseFocus(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
  optionId: string,
): Promise<void> {
  const option = FOCUS_OPTIONS.find((entry) => entry.id === optionId);
  if (!option) throw new IsolationError();
  const { bot, thread } = await requireBotThread(deps, actor, botId);
  const target = {
    spaceId: actor.spaceId,
    botId: bot.id,
    threadId: thread.id,
    sessionId: thread.sessionId,
  };

  const claimed = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const pending = await pendingFocus(tx, target);
    if (!pending) return null;
    await answerCardInTransaction(tx, target, pending.id, { answerId: option.id });
    return threadEventSeq(tx, target.threadId);
  });
  if (claimed === null) return;
  await deps.events.notify(target.threadId, claimed);

  // Keep the name and title the user chose when creating the bot; the focus
  // step only suggests apps, it must not rename the bot.
  await post(deps, target, [
    {
      kind: "text",
      text: `Got it. ${capitalize(option.summary)}. I’ll see what’s already connected so I don’t make you set something up twice.`,
    },
  ]);

  const providers = deps.connectors.managedProviders();
  const catalog = (
    await Promise.all(
      providers.map((provider) =>
        provider
          .catalog({
            operationId: "onboarding.choose",
            traceId: "onboarding.choose",
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: bot.id,
            signal: AbortSignal.timeout(15_000),
          })
          .catch(() => []),
      ),
    )
  ).flat();
  const cards: MessageBlock[] = option.apps.flatMap((slug) => {
    const entry = catalog.find(
      (item) =>
        item.slug.toLowerCase() === slug.toLowerCase() ||
        featuredConnectorProvidersMatch(item.slug, slug),
    );
    if (!entry) return [];
    return [
      {
        kind: "app_connect" as const,
        connectorId: entry.connectorId ?? "composio",
        provider: entry.slug,
        name: entry.name,
        description: APP_DESCRIPTIONS[slug] ?? "",
        logo: entry.logo ?? null,
        status: entry.connected ? ("connected" as const) : ("pending" as const),
      },
    ];
  });
  if (!cards.length) {
    await post(deps, target, [{ kind: "text", text: "What would you like to work on first?" }]);
    return;
  }
  const cardNames = cards
    .map((card) => (card.kind === "app_connect" ? card.name : ""))
    .filter(Boolean);
  const named = `${cardNames.slice(0, -1).join(", ")}${cardNames.length > 1 ? ", and " : ""}${cardNames.at(-1)}`;
  await post(deps, target, [
    {
      kind: "text",
      text: `${named} are a good place to start. Connect them here and I’ll use what you already have.`,
    },
  ]);
  await post(deps, target, cards);
  await post(deps, target, [
    {
      kind: "text",
      text: `Hit those ${cards.length === 1 ? "one" : cards.length === 2 ? "two" : "three"} and I’ll start pulling the picture.`,
    },
  ]);
}

export async function markAppConnected(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
  provider: string,
  connectorId = "composio",
): Promise<void> {
  const { bot, thread } = await requireBotThread(deps, actor, botId);
  const target = {
    spaceId: actor.spaceId,
    botId: bot.id,
    threadId: thread.id,
    sessionId: thread.sessionId,
  };
  const matches = (block: MessageBlock): block is AppConnectBlock =>
    block.kind === "app_connect" &&
    (block.connectorId ?? "composio") === connectorId &&
    featuredConnectorProvidersMatch(block.provider, provider);
  for (const card of await cardsWith(deps.prisma, thread.sessionId, "app_connect")) {
    if (!card.blocks.some((block) => matches(block) && block.status !== "connected")) continue;
    await connectCards(deps, target, card.id, matches);
  }
}

function capitalize(value: string): string {
  return value.length > 0 ? (value[0] ?? "").toUpperCase() + value.slice(1) : value;
}
