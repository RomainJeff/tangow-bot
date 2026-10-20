import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntime, MemoryStore } from "@rakazo/adapter-kit";
import {
  createInMemorySkillLock,
  createRunExecutor,
  createWorkerLifecycle,
  EncryptedSecretStore,
  InMemoryJobQueue,
  LocalAgentHomeStore,
  LocalArtifactStore,
  PiAgentRuntime,
  PostgresSessionLog,
} from "@rakazo/adapters";
import {
  createRunWorkers,
  type GuestConnector,
  type WorkerClock,
} from "@rakazo/adapters/runtime-worker";
import type { SessionEntry } from "@rakazo/contracts";
import { createThreadEvents, type PrismaClient } from "@rakazo/db";
import { openPgliteDatabase } from "@rakazo/db/pglite.test-support";
import { type LocalWorkerFaults, LocalWorkerProvider } from "./local-worker-provider.js";
import { type ModelEmulatorStep, startModelEmulator } from "./model-emulator.js";
import { VolumeComputer } from "./volume-computer.js";

const MODEL_KEY = "worker-fixture-model-key";
const SPACE = "space-worker";
const USER = "user-worker";

const emptyMemory: MemoryStore = {
  describe: () => ({
    id: "empty",
    contractVersion: "1",
    adapterVersion: "1",
    capabilities: { search: false, revisions: false, markdownPortable: false },
  }),
  read: async () => ({ documents: [] }),
  search: async () => [],
  commit: async () => {
    throw new Error("Unexpected memory write");
  },
  async *exportMarkdown() {},
  importMarkdown: async () => {
    throw new Error("Unexpected memory import");
  },
};

/**
 * The real executor on PGlite, with the model emulator behind the controller's relay. Its bot's
 * home is on volumes, so a product run goes to a local guest through the worker routing. `restart`
 * drops the executor, the runtime and the launcher and builds new ones on the same database, as a
 * controller restart would.
 */
export async function startWorkerRun(options: {
  steps: ModelEmulatorStep[];
  mode?: "memory" | "child";
  /** The bundled guest a `child` mode runs instead of the source. */
  guestEntry?: string;
  faults?: LocalWorkerFaults;
  clock?: WorkerClock;
  /** Runs the bot with this runtime and no worker routing. */
  runtime?: (prisma: PrismaClient) => AgentRuntime;
  /** The bot's computer: a dedicated one by default. */
  computerScope?: "team" | "dedicated";
  /** Wraps how the controller reaches the guest, to observe its frames. */
  connector?: (provider: LocalWorkerProvider) => GuestConnector;
  /** Wraps the client the controller uses, to observe its queries. */
  prisma?: (prisma: PrismaClient) => PrismaClient;
}) {
  const database = await openPgliteDatabase();
  const prisma = options.prisma?.(database.prisma) ?? database.prisma;
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-worker-run-"));
  const model = await startModelEmulator({ apiKey: MODEL_KEY, steps: options.steps });
  const secretStore = new EncryptedSecretStore("worker-fixture-encryption-key");
  const sessionLog = new PostgresSessionLog(prisma);
  const sandbox = new VolumeComputer((volumeRef) => current.provider.volumePath(volumeRef));

  await prisma.user.create({ data: { id: USER, name: "Worker", email: "worker@rakazo.test" } });
  await prisma.organization.create({
    data: { id: "org-worker", name: "Worker", slug: "org-worker", createdAt: new Date() },
  });
  await prisma.space.create({ data: { id: SPACE, organizationId: "org-worker", name: "Worker" } });
  const joined = new Date();
  await prisma.member.create({
    data: {
      id: "member-worker",
      organizationId: "org-worker",
      userId: USER,
      role: "owner",
      createdAt: joined,
    },
  });
  await prisma.spaceMember.create({
    data: {
      id: "space-member-worker",
      spaceId: SPACE,
      organizationId: "org-worker",
      userId: USER,
      role: "owner",
      createdAt: joined,
    },
  });
  const computer = await prisma.computer.create({
    data: {
      spaceId: SPACE,
      userId: USER,
      scope: options.computerScope ?? "dedicated",
      scopeKey: "worker-computer",
      homeKey: "worker-computer",
      kind: "e2b",
      homeStorage: "volumes",
    },
  });
  const bot = await prisma.bot.create({
    data: {
      spaceId: SPACE,
      userId: USER,
      name: "Worker",
      color: "#000000",
      computerId: computer.id,
      modelProvider: model.model.provider,
      modelId: model.model.id,
    },
  });
  const sealed = await secretStore.put(
    JSON.stringify({ kind: "openai_compatible", baseUrl: model.baseUrl, apiKey: MODEL_KEY }),
    {
      operationId: "fixture",
      traceId: "fixture",
      spaceId: SPACE,
      userId: USER,
      signal: new AbortController().signal,
    },
  );
  await prisma.secret.create({
    data: { id: sealed.id, userId: USER, kind: "model", ciphertext: sealed.ciphertext },
  });
  const credential = await prisma.userModelCredential.create({
    data: { userId: USER, provider: model.model.provider, label: "Fixture", secretId: sealed.id },
  });
  await prisma.spaceModelPreference.create({
    data: {
      spaceId: SPACE,
      userId: USER,
      credentialId: credential.id,
      modelId: model.model.id,
      isDefault: true,
    },
  });
  await prisma.volume.createMany({
    data: [
      { kind: "bot_private", spaceId: SPACE, botId: bot.id, providerKind: "local-worker" },
      { kind: "space_shared", spaceId: SPACE, providerKind: "local-worker" },
    ].map((volume) => ({ ...volume, providerRef: volume.kind })),
  });
  const thread = await prisma.thread.create({
    data: { spaceId: SPACE, userId: USER, botId: bot.id },
  });
  const events = createThreadEvents(prisma);

  const build = () => {
    const provider = new LocalWorkerProvider({
      mode: options.mode ?? "memory",
      root: path.join(dir, "workers"),
      faults: options.faults,
      entry: options.guestEntry,
    });
    const lifecycle = createWorkerLifecycle({ prisma, provider });
    const runtime: AgentRuntime = options.runtime?.(prisma) ?? new PiAgentRuntime();
    const workers = options.runtime
      ? undefined
      : createRunWorkers({
          prisma,
          lifecycle,
          connector: options.connector?.(provider) ?? provider,
          clock: options.clock,
        });
    const executor = createRunExecutor({
      prisma,
      sessionLog,
      events,
      sandbox,
      home: new LocalAgentHomeStore(path.join(dir, "homes")),
      dataDir: path.join(dir, "data"),
      artifacts: new LocalArtifactStore(path.join(dir, "data")),
      memory: emptyMemory,
      memoryProviders: { resolve: async () => null },
      secretStore,
      jobs: new InMemoryJobQueue(),
      skillLock: createInMemorySkillLock(),
      skillLearning: "off",
      secrets: [],
      runtime,
      workers,
    });
    return { provider, lifecycle, runtime, executor };
  };
  let current = build();

  return {
    prisma,
    model,
    sandbox,
    bot,
    thread,
    events,
    get provider() {
      return current.provider;
    },
    get lifecycle() {
      return current.lifecycle;
    },
    /** A user message that starts a queued run. */
    async send(text: string) {
      const sent = await events.sendUserMessage({
        spaceId: SPACE,
        threadId: thread.id,
        botId: bot.id,
        userId: USER,
        blocks: [{ kind: "text", text }],
        prompt: text,
        trigger: "user",
      });
      return sent.runId!;
    },
    continueRun(runId: string) {
      return current.executor.continueRun(runId, "worker-fixture");
    },
    /** Builds a new controller on the same database; the old one's guests are left as they are. */
    restart() {
      const old = current;
      current = build();
      return old.provider;
    },
    runEntries(runId: string): Promise<SessionEntry[]> {
      return sessionLog.readRun(runId);
    },
    userId: USER,
    spaceId: SPACE,
    async close() {
      await current.provider.dispose();
      await model.close();
      await database.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
