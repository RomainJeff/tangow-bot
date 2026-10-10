import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

/**
 * An in-memory stand-in for the slice of Prisma the link preview code touches, with the one
 * property the concurrency tests need from Postgres: a transaction that runs `SELECT ... FOR
 * UPDATE` on a thread, or updates it, holds that thread until it ends, and a second one waits.
 * Offline and deterministic. A transaction that throws is rolled back.
 */
type Row = Record<string, unknown> & { id: string };

function tableOf(db: Map<string, Row>) {
  return db;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined) {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (cond === undefined) continue;
    if (key === "OR") {
      if (!(cond as Array<Record<string, unknown>>).some((c) => matches(row, c))) return false;
      continue;
    }
    const value = row[key];
    if (cond instanceof Date) {
      if ((value as Date)?.getTime() !== cond.getTime()) return false;
    } else if (cond !== null && typeof cond === "object") {
      const c = cond as Record<string, unknown>;
      const time = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
      if ("in" in c) {
        if (!(c.in as unknown[]).includes(value)) return false;
      } else if ("not" in c) {
        if (c.not === null ? value == null : value === c.not) return false;
      } else if ("startsWith" in c) {
        if (typeof value !== "string" || !value.startsWith(c.startsWith as string)) return false;
      } else if ("gte" in c || "lt" in c || "lte" in c || "gt" in c) {
        if ("gte" in c && !(time(value) >= time(c.gte))) return false;
        if ("gt" in c && !(time(value) > time(c.gt))) return false;
        if ("lt" in c && !(time(value) < time(c.lt))) return false;
        if ("lte" in c && !(time(value) <= time(c.lte))) return false;
      } else if ("path" in c) {
      }
      // Any other object is a relation filter: the fakes do not model them.
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

export interface FakeThreadDb {
  prisma: PrismaClient;
  artifacts: ArtifactStore & { keys(): string[] };
  tables: {
    threads: Map<string, Row>;
    messages: Map<string, Row>;
    events: Map<string, Row>;
    runs: Map<string, Row>;
    artifact: Map<string, Row>;
    linkPreviewCache: Map<string, Row>;
    linkPreviewRead: Map<string, Row>;
    chatGroupMembers: Map<string, Row>;
    externalMessages: Map<string, Row>;
    externalEffects: Map<string, Row>;
    skillSettings: Map<string, Row>;
    botSkills: Map<string, Row>;
  };
  seedThread(input: {
    id: string;
    spaceId?: string;
    userId?: string;
    botId?: string | null;
    groupId?: string | null;
  }): void;
  seedMessage(input: {
    id: string;
    threadId: string;
    role?: string;
    blocks: unknown[];
    runId?: string;
    clientNonce?: string | null;
    botId?: string | null;
    replyToMessageId?: string | null;
    replyQuote?: string | null;
    hiddenFromThread?: boolean;
    createdAt?: Date;
  }): void;
  seedRun(input: {
    id: string;
    threadId: string;
    status?: string;
    trigger?: string;
    botId?: string;
    updatedAt?: Date;
    createdAt?: Date;
  }): void;
  /** Called after every message read, to let another transaction run in between. */
  onMessageRead(hook: (() => Promise<void>) | undefined): void;
  blocksOf(messageId: string): unknown[] | undefined;
  eventsOfType(type: string): Row[];
}

export function createFakeThreadDb(): FakeThreadDb {
  const tables = {
    threads: new Map<string, Row>(),
    messages: new Map<string, Row>(),
    events: new Map<string, Row>(),
    runs: new Map<string, Row>(),
    artifact: new Map<string, Row>(),
    linkPreviewCache: new Map<string, Row>(),
    linkPreviewRead: new Map<string, Row>(),
    chatGroupMembers: new Map<string, Row>(),
    externalMessages: new Map<string, Row>(),
    externalEffects: new Map<string, Row>(),
    skillSettings: new Map<string, Row>(),
    botSkills: new Map<string, Row>(),
  };
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;
  const locks = new Map<string, Promise<void>>();
  const hooks: { afterMessageRead?: () => Promise<void> } = {};

  const store = new Map<string, Uint8Array>();
  const artifacts: FakeThreadDb["artifacts"] = {
    describe: () => ({
      id: "fake",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { stream: false },
    }),
    async put(artifact) {
      const id = nextId("blob");
      store.set(id, artifact.bytes);
      return { id, hash: String(artifact.bytes.byteLength) };
    },
    async get(id) {
      const bytes = store.get(id);
      if (!bytes) throw new Error("ENOENT");
      return bytes;
    },
    async remove(id) {
      store.delete(id);
    },
    keys: () => [...store.keys()],
  };

  const table = (rows: Map<string, Row>, extra: Record<string, unknown> = {}) => ({
    async findMany(args: { where?: Record<string, unknown>; take?: number } = {}) {
      return [...rows.values()].filter((row) => matches(row, args.where)).slice(0, args.take);
    },
    async findFirst(args: { where?: Record<string, unknown> } = {}) {
      return [...rows.values()].find((row) => matches(row, args.where)) ?? null;
    },
    async count(args: { where?: Record<string, unknown> } = {}) {
      return [...rows.values()].filter((row) => matches(row, args.where)).length;
    },
    async deleteMany(args: { where?: Record<string, unknown> } = {}) {
      let count = 0;
      for (const [id, row] of rows) {
        if (matches(row, args.where)) {
          rows.delete(id);
          count += 1;
        }
      }
      return { count };
    },
    ...extra,
  });

  function build(held: Set<string>, onLock: (threadId: string) => Promise<void>) {
    const lockThread = async (threadId: string) => {
      if (held.has(threadId)) return;
      await onLock(threadId);
      held.add(threadId);
    };
    const withRelations = (message: Row) => ({
      ...message,
      thread: tables.threads.get(message.threadId as string),
      externalTranscriptFor:
        [...tables.externalMessages.values()].find((row) => row.threadMessageId === message.id) ??
        null,
    });
    return {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join("?").includes("FOR UPDATE")) await lockThread(values[0] as string);
        return [];
      },
      $executeRaw: async () => 0,
      thread: {
        async findUnique(args: { where: { id?: string; botId?: string } }) {
          const { id, botId } = args.where;
          if (id) return tables.threads.get(id) ?? null;
          return [...tables.threads.values()].find((row) => row.botId === botId) ?? null;
        },
        async findFirst(args: { where: Record<string, unknown> }) {
          return [...tables.threads.values()].find((row) => matches(row, args.where)) ?? null;
        },
        async update(args: { where: { id: string }; data: Record<string, unknown> }) {
          await lockThread(args.where.id);
          const row = tables.threads.get(args.where.id);
          if (!row) throw new Error("thread missing");
          for (const field of ["nextEventSeq", "nextMessageSeq"]) {
            const inc = (args.data[field] as { increment?: number } | undefined)?.increment;
            if (inc !== undefined) row[field] = (row[field] as number) + inc;
          }
          if (args.data.unread !== undefined) row.unread = args.data.unread;
          return row;
        },
      },
      message: {
        async findUnique(args: { where: { id: string } }) {
          const row = tables.messages.get(args.where.id);
          const read = row ? structuredClone(withRelations(row)) : null;
          await hooks.afterMessageRead?.();
          return read;
        },
        async findFirst(args: { where: Record<string, unknown> }) {
          const row = [...tables.messages.values()].find((m) => matches(m, args.where));
          const read = row ? structuredClone(withRelations(row)) : null;
          await hooks.afterMessageRead?.();
          return read;
        },
        async findMany(args: { where: Record<string, unknown> }) {
          return [...tables.messages.values()]
            .filter((m) => matches(m, args.where))
            .sort((a, b) => (a.seq as number) - (b.seq as number))
            .map(withRelations);
        },
        async update(args: { where: { id: string }; data: Record<string, unknown> }) {
          const row = tables.messages.get(args.where.id);
          if (!row) throw new Error("message missing");
          Object.assign(row, args.data);
          return row;
        },
        async create(args: { data: Record<string, unknown> }) {
          const row = {
            id: nextId("message"),
            runId: null,
            clientNonce: null,
            hiddenFromThread: false,
            replyToMessageId: null,
            replyQuote: null,
            ...args.data,
          } as Row;
          tables.messages.set(row.id, row);
          return row;
        },
        async deleteMany(args: { where: Record<string, unknown> }) {
          for (const [id, row] of tables.messages) {
            if (matches(row, args.where)) {
              tables.messages.delete(id);
              // The foreign key: an artifact pointing at a deleted message loses the link.
              for (const artifact of tables.artifact.values()) {
                if (artifact.previewMessageId === id) artifact.previewMessageId = null;
              }
            }
          }
        },
      },
      run: {
        async findUnique(args: { where: { id: string } }) {
          const run = tables.runs.get(args.where.id);
          return run ? { ...run, thread: tables.threads.get(run.threadId as string) } : null;
        },
        async findFirst(args: { where: Record<string, unknown> }) {
          return [...tables.runs.values()].find((run) => matches(run, args.where)) ?? null;
        },
        async findMany(args: { where: Record<string, unknown>; distinct?: string[] }) {
          const rows = [...tables.runs.values()].filter((run) => matches(run, args.where));
          const seen = new Set<string>();
          return rows.filter((run) => {
            const key = JSON.stringify((args.distinct ?? ["id"]).map((field) => run[field]));
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        },
        async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
          const rows = [...tables.runs.values()].filter((run) => matches(run, args.where));
          for (const run of rows) Object.assign(run, args.data);
          return { count: rows.length };
        },
      },
      task: {
        async updateMany() {
          return { count: 1 };
        },
      },
      // What clearing or rewinding a thread also touches, with nothing to keep here.
      attempt: { updateMany: async () => ({ count: 0 }) },
      computer: { updateMany: async () => ({ count: 0 }) },
      computerExecutionLease: { updateMany: async () => ({ count: 0 }) },
      bot: { update: async () => ({}) },
      chatGroup: { update: async () => ({}) },
      event: {
        async create(args: { data: Record<string, unknown> }) {
          const row = { id: nextId("event"), createdAt: new Date(), ...args.data } as Row;
          tables.events.set(row.id, row);
          return row;
        },
        async findFirst(args: { where: Record<string, unknown> }) {
          return [...tables.events.values()].find((e) => matches(e, args.where)) ?? null;
        },
        async deleteMany(args: { where: Record<string, unknown> }) {
          for (const [id, row] of tables.events) {
            if (matches(row, args.where)) tables.events.delete(id);
          }
        },
        async findMany(args: { where: Record<string, unknown> }) {
          return [...tables.events.values()]
            .filter((e) => matches(e, args.where))
            .sort((a, b) => (a.seq as number) - (b.seq as number));
        },
      },
      artifact: table(tables.artifact, {
        async create(args: { data: Record<string, unknown> }) {
          const message = args.data.previewMessageId as string | undefined;
          if (message && !tables.messages.has(message)) throw new Error("foreign key");
          const row = { id: nextId("artifact"), createdAt: new Date(), ...args.data } as Row;
          tables.artifact.set(row.id, row);
          return row;
        },
      }),
      chatGroupMember: table(tables.chatGroupMembers),
      externalEffect: table(tables.externalEffects),
      skillSetting: table(tables.skillSettings),
      botSkill: table(tables.botSkills),
      linkPreviewRead: table(tables.linkPreviewRead, {
        async create(args: { data: Record<string, unknown> }) {
          const row = { id: nextId("read"), ...args.data } as Row;
          tables.linkPreviewRead.set(row.id, row);
          return row;
        },
      }),
      linkPreviewCache: table(tables.linkPreviewCache, {
        async findUnique(args: {
          where: { spaceId_keyHash: { spaceId: string; keyHash: string } };
        }) {
          const { spaceId, keyHash } = args.where.spaceId_keyHash;
          return (
            [...tables.linkPreviewCache.values()].find(
              (row) => row.spaceId === spaceId && row.keyHash === keyHash,
            ) ?? null
          );
        },
        async findMany(args: { where?: Record<string, unknown>; take?: number }) {
          return [...tables.linkPreviewCache.values()]
            .filter((row) => matches(row, args.where))
            .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime())
            .slice(0, args.take);
        },
        async upsert(args: {
          where: { spaceId_keyHash: { spaceId: string; keyHash: string } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) {
          const { spaceId, keyHash } = args.where.spaceId_keyHash;
          const existing = [...tables.linkPreviewCache.values()].find(
            (row) => row.spaceId === spaceId && row.keyHash === keyHash,
          );
          if (existing) return Object.assign(existing, args.update);
          const row = { id: nextId("cache"), ...args.create } as Row;
          tables.linkPreviewCache.set(row.id, row);
          return row;
        },
      }),
    };
  }

  const prisma = {
    ...build(new Set(), async () => undefined),
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const held = new Set<string>();
      const releases: Array<() => void> = [];
      const acquire = async (threadId: string) => {
        // Wait for the transaction holding the thread, then hold it until this one ends.
        while (locks.has(threadId)) await locks.get(threadId);
        let release!: () => void;
        locks.set(
          threadId,
          new Promise<void>((resolve) => {
            release = () => {
              locks.delete(threadId);
              resolve();
            };
          }),
        );
        releases.push(release);
      };
      const snapshot = Object.fromEntries(
        Object.entries(tables).map(([name, rows]) => [
          name,
          new Map([...rows].map(([id, row]) => [id, structuredClone(row)])),
        ]),
      ) as typeof tables;
      try {
        return await fn(build(held, acquire));
      } catch (error) {
        for (const [name, rows] of Object.entries(snapshot)) {
          const live = tableOf(tables[name as keyof typeof tables]);
          live.clear();
          for (const [id, row] of rows) live.set(id, row);
        }
        throw error;
      } finally {
        for (const release of releases) release();
      }
    },
  } as unknown as PrismaClient;

  return {
    prisma,
    artifacts,
    tables,
    seedThread({ id, spaceId = "space-1", userId = "user-1", botId, groupId = null }) {
      tables.threads.set(id, {
        id,
        spaceId,
        userId,
        botId: botId === undefined ? "bot-1" : botId,
        groupId,
        nextEventSeq: 0,
        nextMessageSeq: 0,
        unread: false,
      });
    },
    seedMessage({
      id,
      threadId,
      role = "user",
      blocks,
      runId,
      clientNonce = null,
      botId = null,
      replyToMessageId = null,
      replyQuote = null,
      hiddenFromThread = false,
      createdAt,
    }) {
      tables.messages.set(id, {
        id,
        threadId,
        seq: tables.messages.size,
        role,
        blocks,
        runId: runId ?? null,
        clientNonce,
        botId,
        replyToMessageId,
        replyQuote,
        hiddenFromThread,
        createdAt,
      });
    },
    seedRun({
      id,
      threadId,
      status = "completed",
      trigger = "user",
      botId = "bot-1",
      updatedAt = new Date(),
      createdAt = updatedAt,
    }) {
      tables.runs.set(id, {
        id,
        threadId,
        status,
        trigger,
        spaceId: "space-1",
        botId,
        userId: "user-1",
        checkpoint: null,
        skillLinesAt: null,
        updatedAt,
        createdAt,
      });
    },
    onMessageRead(hook) {
      hooks.afterMessageRead = hook;
    },
    blocksOf: (messageId) => tables.messages.get(messageId)?.blocks as unknown[] | undefined,
    eventsOfType: (type) => [...tables.events.values()].filter((event) => event.type === type),
  };
}
