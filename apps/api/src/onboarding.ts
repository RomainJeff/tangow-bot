import type { ConnectorRegistry } from "@rakazo/adapters";
import type { Actor, MessageBlock, SessionEntryOf, SessionId } from "@rakazo/contracts";
import { appConnectAnswerId, CHOICE_DISMISSED_ANSWER_ID, EntryId } from "@rakazo/contracts";
import { featuredConnectorProvidersMatch } from "@rakazo/core";
import {
  appendCardStateInTransaction,
  appendEventInTransaction,
  appendSessionEntryInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  type Prisma,
  type PrismaClient,
  type ThreadEvents,
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
) {
  const message = await createThreadMessageInTransaction(tx, {
    threadId: target.threadId,
    role: "bot",
    blocks,
  });
  await appendSessionEntryInTransaction(tx, {
    id: EntryId.parse(message.id),
    type: "bot.text",
    sessionId: target.sessionId as SessionId,
    botId: target.botId,
    payload: { blocks },
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: target.spaceId,
    threadId: target.threadId,
    botId: target.botId,
    type: "thread.message.created",
    payload: { messageId: message.id, role: "bot", blocks },
  });
  return { message, event };
}

async function post(
  deps: OnboardingDeps,
  target: BotThreadTarget,
  blocks: MessageBlock[],
): Promise<string> {
  const committed = await deps.prisma.$transaction((tx: Prisma.TransactionClient) =>
    postInTransaction(tx, target, blocks),
  );
  await deps.events.notify(target.threadId, committed.event.seq);
  return committed.message.id;
}

type CardAnswer = Omit<SessionEntryOf<"card.answered">["payload"], "target">;
type AppConnectBlock = Extract<MessageBlock, { kind: "app_connect" }>;

/**
 * Marks one message's matching app cards connected under the thread lock, from the blocks as
 * stored right now: a link preview card or its removal marker written since the caller last
 * looked is kept.
 */
async function connectCards(
  deps: OnboardingDeps,
  target: BotThreadTarget,
  messageId: string,
  matches: (block: MessageBlock) => block is AppConnectBlock,
): Promise<void> {
  const event = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const message = await tx.message.findFirst({
      where: { id: messageId, threadId: target.threadId },
      select: { blocks: true },
    });
    if (!message || !Array.isArray(message.blocks)) return null;
    const stored = message.blocks as MessageBlock[];
    const blocks = stored.map((block) =>
      matches(block) ? { ...block, status: "connected" as const } : block,
    );
    await tx.message.update({ where: { id: messageId }, data: { blocks } });
    for (const card of stored.filter(matches)) {
      if (card.status === "connected") continue;
      await answerCardInTransaction(tx, target, messageId, { answerId: appConnectAnswerId(card) });
    }
    return appendEventInTransaction(tx, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.message.updated",
      payload: { messageId, role: "bot", blocks },
    });
  });
  if (event) await deps.events.notify(target.threadId, event.seq);
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

export async function startOnboarding(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
): Promise<void> {
  const { thread } = await requireBotThread(deps, actor, botId);
  const existing = await deps.prisma.message.count({ where: { threadId: thread.id } });
  if (existing > 0) return;
  // Fresh chats start empty (same as web). The focus card is posted later via
  // promptFocus so non-first bots can wait ~10s for free typing, or skip if the
  // user already engaged.
}

function messageHasChoice(blocks: MessageBlock[]): boolean {
  return blocks.some((block) => block.kind === "choice");
}

function messageHasPendingChoice(blocks: MessageBlock[]): boolean {
  return blocks.some((block) => block.kind === "choice" && !block.answerId);
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
    const recent = await tx.message.findMany({
      where: { threadId: thread.id },
      select: { role: true, blocks: true },
      orderBy: { createdAt: "asc" },
    });
    if (recent.some((message) => message.role === "user")) return null;
    if (recent.some((message) => messageHasChoice(message.blocks as MessageBlock[]))) return null;
    return postInTransaction(tx, target, blocks);
  });
  if (!committed) return;
  await deps.events.notify(target.threadId, committed.event.seq);
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
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
    const recent = await tx.message.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: "asc" },
    });
    const pending = recent.find((message) =>
      messageHasPendingChoice(message.blocks as MessageBlock[]),
    );
    if (!pending) return null;
    const blocks = (pending.blocks as MessageBlock[]).map((block) =>
      block.kind === "choice" && !block.answerId
        ? { ...block, answerId: CHOICE_DISMISSED_ANSWER_ID }
        : block,
    );
    await tx.message.update({ where: { id: pending.id }, data: { blocks } });
    await answerCardInTransaction(tx, target, pending.id, { dismissed: true });
    const event = await appendEventInTransaction(tx, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.message.updated",
      payload: { messageId: pending.id, role: "bot", blocks },
    });
    return { messageId: pending.id, blocks, event };
  });
  if (!claimed) return;
  await deps.events.notify(target.threadId, claimed.event.seq);
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
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
    const recent = await tx.message.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: "asc" },
    });
    const pending = recent.find((message) =>
      messageHasPendingChoice(message.blocks as MessageBlock[]),
    );
    if (!pending) return null;
    const blocks = (pending.blocks as MessageBlock[]).map((block) =>
      block.kind === "choice" ? { ...block, answerId: option.id } : block,
    );
    await tx.message.update({ where: { id: pending.id }, data: { blocks } });
    await answerCardInTransaction(tx, target, pending.id, { answerId: option.id });
    const event = await appendEventInTransaction(tx, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.message.updated",
      payload: { messageId: pending.id, role: "bot", blocks },
    });
    return { messageId: pending.id, blocks, event };
  });
  if (!claimed) return;
  await deps.events.notify(target.threadId, claimed.event.seq);

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
  const messages = await deps.prisma.message.findMany({
    where: { threadId: thread.id },
    select: { id: true, blocks: true },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  const matches = (block: MessageBlock): block is AppConnectBlock =>
    block.kind === "app_connect" &&
    (block.connectorId ?? "composio") === connectorId &&
    featuredConnectorProvidersMatch(block.provider, provider);
  for (const message of messages) {
    const blocks = message.blocks as MessageBlock[];
    if (!blocks.some((block) => matches(block) && block.status !== "connected")) continue;
    await connectCards(deps, target, message.id, matches);
  }
}

function capitalize(value: string): string {
  return value.length > 0 ? (value[0] ?? "").toUpperCase() + value.slice(1) : value;
}
