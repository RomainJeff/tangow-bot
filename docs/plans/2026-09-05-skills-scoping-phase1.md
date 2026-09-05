# Skills v2 — Phase 1 : scoping par bot — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Une skill (`AgentSkill`) est visible soit par tous les bots du couple (space, user), soit par une sélection de bots ; les bots ne voient (catalogue, `/Name`, `skill_read`) que leurs skills visibles ; l'UI expose des chips agents sur chaque skill.

**Architecture:** Deux tables clé-valeur indexées par `skillKey` (`"user:" + lower(name)`, même règle que l'index unique case-insensitive) : `SkillSetting {availability: all|selected}` et `BotSkill {botId, enabled}`. Résolution `visible = BotSkill.enabled ?? (availability === "all")` dans un helper pur `@rakazo/core`. Point d'entrée unique côté runtime : `listAgentSkillRecords(prisma, {spaceId, userId, botId?})` (déjà appelé par executor + tools). Côté API, `agentSkills.list` renvoie `availability` + `visibleBotIds` par skill et accepte `botId?` pour filtrer ; un seul write `agentSkills.setAccess`. Rename cascade et GC à la suppression dans la même transaction que la mutation d'`AgentSkill`. Design complet : `docs/plans/2026-09-03-skills-system-design.md` §2 (Axe 1), Q2/Q3/Q7.

**Tech Stack:** pnpm monorepo, TypeScript, Prisma 7 (migrations SQL écrites à la main), oRPC + zod (`packages/contracts`), React + lingui (`apps/web`), vitest, Playwright.

**Conventions repo :**
- Tests unitaires : `vitest run --root ../.. <dir>` via `pnpm --filter <pkg> test`. Mocks Prisma à la main (voir `packages/adapters/src/skill-tools.test.ts`).
- Typecheck : `pnpm --filter <pkg> check`. Lint : `pnpm lint` (biome). Format : `pnpm format`.
- E2E : `pnpm --filter @rakazo/web e2e <spec>` (stack compose démarrée, cf. `apps/web/e2e/helpers.ts`).
- Commits : message clair, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. **Ne jamais pousser sur `origin`** (elie222/rakazo) ; pousser sur `romainjeff` : `git push romainjeff main`.
- Ne pas toucher `docs/plans/2026-09-05-channels.md` (untracked, pas à nous).

**Décisions phase 1 (déjà tranchées, ne pas rouvrir) :**
- Skill créée par un bot via `skill_create` → `availability=selected` + `BotSkill[bot créateur].enabled=true`.
- Skill créée à la main dans le panneau, ou existante avant migration → `all` (aucune ligne à créer : absence de `SkillSetting` = `all`).
- Builtins (`BUILTIN_AGENT_SKILLS`, liste vide aujourd'hui) : toujours visibles, pas de chips.
- Cap catalogue 50 inchangé, compte seulement les skills visibles (automatique une fois le filtre en place).
- `TaughtSkill` hors périmètre.
- **Simplification assumée (ponytail)** : pas de section « Skills » séparée dans `BotSettings`. `KnowledgeSection` (onglet Skills) est déjà rendu dans `BotSettings > Advanced` et reçoit `botId` ; les chips y couvrent le bot courant et les autres. À rediscuter si Romain veut une vue « que les skills de ce bot ».

---

## Task 1 : helper pur `skill-access` dans `@rakazo/core`

**Files:**
- Create: `packages/core/src/skill-access.ts`
- Create: `packages/core/src/skill-access.test.ts`
- Modify: `packages/core/src/index.ts` (ajouter un export)

**Step 1: Write the failing test**

```ts
// packages/core/src/skill-access.test.ts
import { describe, expect, it } from "vitest";
import { asSkillAvailability, isSkillVisible, userSkillKey } from "./skill-access.js";

describe("skill access", () => {
  it("derives a stable key from the case-insensitive unique name", () => {
    expect(userSkillKey("Daily standup")).toBe("user:daily standup");
    expect(userSkillKey("  DAILY STANDUP ")).toBe("user:daily standup");
  });

  it("defaults to visible when nothing is configured", () => {
    expect(isSkillVisible({})).toBe(true);
    expect(isSkillVisible({ availability: "all" })).toBe(true);
    expect(isSkillVisible({ availability: "selected" })).toBe(false);
  });

  it("lets a bot override win over availability", () => {
    expect(isSkillVisible({ availability: "all", override: false })).toBe(false);
    expect(isSkillVisible({ availability: "selected", override: true })).toBe(true);
    expect(isSkillVisible({ availability: "selected", override: null })).toBe(false);
  });

  it("coerces unknown availability strings to all", () => {
    expect(asSkillAvailability("selected")).toBe("selected");
    expect(asSkillAvailability("garbage")).toBe("all");
    expect(asSkillAvailability(undefined)).toBe("all");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ~/workspace/rakazo-bot && pnpm --filter @rakazo/core test -- skill-access`
Expected: FAIL — `Cannot find module './skill-access.js'`

**Step 3: Write minimal implementation**

```ts
// packages/core/src/skill-access.ts
/**
 * Per-bot skill visibility (Skills v2, phase 1).
 * `skillKey` is the identity shared by SkillSetting / BotSkill rows. For user skills it is
 * derived from the name with the same rule as the case-insensitive unique index on
 * agent_skills (lower(name)), so a rename is the only thing that changes it.
 */
export type SkillAvailability = "all" | "selected";

export function userSkillKey(name: string): string {
  return `user:${name.trim().toLowerCase()}`;
}

export function asSkillAvailability(value: string | null | undefined): SkillAvailability {
  return value === "selected" ? "selected" : "all";
}

/** BotSkill.enabled (override) wins; otherwise availability decides. Missing = "all". */
export function isSkillVisible(input: {
  availability?: SkillAvailability | null;
  override?: boolean | null;
}): boolean {
  if (typeof input.override === "boolean") return input.override;
  return (input.availability ?? "all") === "all";
}
```

Ajouter dans `packages/core/src/index.ts` (à côté de `export * from "./agent-skill.js";`) :

```ts
export * from "./skill-access.js";
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @rakazo/core test -- skill-access && pnpm --filter @rakazo/core check`
Expected: 4 tests PASS, tsc silencieux.

**Step 5: Commit**

```bash
git add packages/core/src/skill-access.ts packages/core/src/skill-access.test.ts packages/core/src/index.ts
git commit -m "core: add skill visibility helper for per-bot scoping

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 2 : modèles Prisma `SkillSetting` + `BotSkill` et migration SQL

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (Space ~L21-45 relations, Bot ~L312-372, nouveau bloc après `BotMcpServer` ~L1013)
- Create: `packages/db/prisma/migrations/20260905120000_bot_skill_scoping/migration.sql`

**Step 1: Ajouter les modèles**

Après le modèle `BotMcpServer` (fin de fichier ou juste après `@@map("bot_mcp_servers") }`) :

```prisma
/// Skills v2 phase 1 — global availability of a skill, keyed by skillKey ("user:<lower(name)>").
/// No row = "all". Rows are renamed with the skill and deleted with it.
model SkillSetting {
  id           String   @id @default(cuid())
  spaceId      String
  space        Space    @relation(fields: [spaceId], references: [id], onDelete: Cascade)
  userId       String
  skillKey     String
  availability String   @default("all")
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([spaceId, userId, skillKey])
  @@map("skill_settings")
}

/// Skills v2 phase 1 — per-bot override. enabled=true includes, enabled=false excludes.
model BotSkill {
  id        String   @id @default(cuid())
  spaceId   String
  space     Space    @relation(fields: [spaceId], references: [id], onDelete: Cascade)
  botId     String
  bot       Bot      @relation(fields: [botId], references: [id], onDelete: Cascade)
  userId    String
  skillKey  String
  enabled   Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([botId, skillKey])
  @@index([spaceId, userId, skillKey])
  @@map("bot_skills")
}
```

Dans `model Space`, à côté de `botMcpServers BotMcpServer[]` :

```prisma
  skillSettings               SkillSetting[]
  botSkills                   BotSkill[]
```

Dans `model Bot`, à côté de `mcpServers BotMcpServer[]` :

```prisma
  skills            BotSkill[]
```

**Step 2: Écrire la migration**

```sql
-- packages/db/prisma/migrations/20260905120000_bot_skill_scoping/migration.sql
-- Skills v2 phase 1: per-bot skill scoping. Existing skills keep today's behaviour
-- (visible to every bot) because a missing skill_settings row means "all".

CREATE TABLE "skill_settings" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "skillKey" TEXT NOT NULL,
  "availability" TEXT NOT NULL DEFAULT 'all',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "skill_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bot_skills" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "skillKey" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bot_skills_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "skill_settings_spaceId_userId_skillKey_key" ON "skill_settings"("spaceId", "userId", "skillKey");
CREATE UNIQUE INDEX "bot_skills_botId_skillKey_key" ON "bot_skills"("botId", "skillKey");
CREATE INDEX "bot_skills_spaceId_userId_skillKey_idx" ON "bot_skills"("spaceId", "userId", "skillKey");

ALTER TABLE "skill_settings" ADD CONSTRAINT "skill_settings_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_skills" ADD CONSTRAINT "bot_skills_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_skills" ADD CONSTRAINT "bot_skills_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

**Step 3: Vérifier**

Run: `pnpm db:generate`
Expected: `✔ Generated Prisma Client` sans erreur de validation.

Run (Postgres local via compose, `DATABASE_URL` de `.env`) : `pnpm db:migrate`
Expected: `Applying migration 20260905120000_bot_skill_scoping` puis `All migrations have been successfully applied.`

Puis vérifier que schema et migrations sont alignés :

Run: `cd packages/db && pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$DATABASE_URL" --exit-code; cd ../..`
Expected: `No difference detected.` (exit 0). Si diff → corriger le SQL, pas le schema.

**Step 4: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260905120000_bot_skill_scoping/migration.sql
git commit -m "db: add skill_settings and bot_skills for per-bot skill scoping

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 3 : contrats oRPC

**Files:**
- Modify: `packages/contracts/src/domain.ts` (~L381-405, `AgentSkillSourceSchema` / `AgentSkillCatalogEntrySchema`)
- Modify: `packages/contracts/src/rpc.ts` (~L452-472, bloc `agentSkills`)

**Step 1: Étendre le domaine**

Dans `domain.ts`, sous `AgentSkillSourceSchema` :

```ts
export const SkillAvailabilitySchema = z.enum(["all", "selected"]);
export type SkillAvailability = z.infer<typeof SkillAvailabilitySchema>;
```

Remplacer la définition de `AgentSkillCatalogEntrySchema` (garder le `pick` existant, ajouter `.extend`) :

```ts
export const AgentSkillCatalogEntrySchema = AgentSkillSchema.pick({
  id: true,
  name: true,
  description: true,
  source: true,
  readOnly: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  /** Global default: visible to every bot, or only to bots listed in visibleBotIds. */
  availability: SkillAvailabilitySchema,
  /** Resolved per active bot (availability + per-bot override). */
  visibleBotIds: z.array(Id),
});
```

(Vérifier la liste des champs du `pick` existant avec `sed -n '396,410p' packages/contracts/src/domain.ts` et la conserver telle quelle.)

**Step 2: Étendre le contrat `agentSkills`**

Dans `rpc.ts`, bloc `agentSkills` :

```ts
  agentSkills: {
    /** botId: only skills visible to that bot (slash picker, runtime parity). */
    list: oc
      .input(z.object({ botId: Id.optional() }).optional())
      .output(z.array(AgentSkillCatalogEntrySchema)),
    get: /* inchangé */,
    create: /* inchangé */,
    update: /* inchangé */,
    remove: /* inchangé */,
    /** One write path for both the global toggle and the per-bot chips. */
    setAccess: oc
      .input(
        z.object({
          skillId: Id,
          availability: SkillAvailabilitySchema.optional(),
          bot: z.object({ botId: Id, enabled: z.boolean() }).optional(),
        }),
      )
      .output(AgentSkillCatalogEntrySchema),
  },
```

Importer `SkillAvailabilitySchema` depuis `./domain.js` dans `rpc.ts` (voir la liste d'imports existante en tête de fichier, l'ajouter par ordre alphabétique).

**Step 3: Vérifier**

Run: `pnpm --filter @rakazo/contracts check`
Expected: OK. Puis `pnpm --filter @rakazo/api check` et `pnpm --filter @rakazo/web check` **doivent échouer** (handlers/UI pas encore à jour) — c'est attendu, on les corrige Tasks 6-7.

**Step 4: Commit**

```bash
git add packages/contracts/src/domain.ts packages/contracts/src/rpc.ts
git commit -m "contracts: expose skill availability and per-bot access on agentSkills

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 4 : runtime — `listAgentSkillRecords` filtre par bot, `skill_create` scope, rename cascade, GC

**Files:**
- Modify: `packages/adapters/src/skill-tools.ts`
- Modify: `packages/adapters/src/skill-tools.test.ts` (mock + 3 tests)

**Step 1: Étendre le mock Prisma du test**

Dans `makePrisma`, ajouter à l'objet retourné (à côté de `agentSkill`) deux stores simples + `$transaction` :

```ts
  const settings: Array<Record<string, unknown>> = [];
  const overrides: Array<Record<string, unknown>> = [];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const table = (store: Array<Record<string, unknown>>) => ({
    findMany: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) =>
      store.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: Record<string, Record<string, unknown>>;
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const key = Object.values(where)[0] ?? {};
        const index = store.findIndex((row) => matches(row, key));
        if (index >= 0) {
          store[index] = { ...store[index], ...update };
          return store[index];
        }
        const row = { id: `row-${store.length + 1}`, ...create };
        store.push(row);
        return row;
      },
    ),
    updateMany: vi.fn(
      async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of store) {
          if (matches(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
    ),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const before = store.length;
      for (let i = store.length - 1; i >= 0; i -= 1) {
        if (matches(store[i], where)) store.splice(i, 1);
      }
      return { count: before - store.length };
    }),
  });
  const prisma = {
    agentSkill: { /* existant, inchangé */ },
    skillSetting: table(settings),
    botSkill: table(overrides),
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === "function" ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as Promise<unknown>[]),
    ),
  };
  return prisma;
```

(Restructurer `makePrisma` pour que `prisma` soit une `const` référencée par `$transaction` ; le `return { agentSkill: {...} }` actuel devient `const prisma = {...}; return prisma;`. Les tests existants ne changent pas.)

**Step 2: Write the failing tests**

Ajouter à la fin du `describe("skill tools")` :

```ts
  it("filters the catalog by bot visibility when botId is given", async () => {
    prisma = makePrisma([
      { id: "s1", spaceId: "w1", userId: "u1", name: "Everyone", description: "d", content: buildSkillMd({ name: "Everyone", description: "d", body: "" }), source: "user" },
      { id: "s2", spaceId: "w1", userId: "u1", name: "Only bot A", description: "d", content: buildSkillMd({ name: "Only bot A", description: "d", body: "" }), source: "user" },
      { id: "s3", spaceId: "w1", userId: "u1", name: "Not for A", description: "d", content: buildSkillMd({ name: "Not for A", description: "d", body: "" }), source: "user" },
    ]);
    await prisma.skillSetting.upsert({
      where: { spaceId_userId_skillKey: { spaceId: "w1", userId: "u1", skillKey: "user:only bot a" } },
      create: { spaceId: "w1", userId: "u1", skillKey: "user:only bot a", availability: "selected" },
      update: {},
    });
    await prisma.botSkill.upsert({
      where: { botId_skillKey: { botId: "botA", skillKey: "user:only bot a" } },
      create: { spaceId: "w1", userId: "u1", botId: "botA", skillKey: "user:only bot a", enabled: true },
      update: {},
    });
    await prisma.botSkill.upsert({
      where: { botId_skillKey: { botId: "botA", skillKey: "user:not for a" } },
      create: { spaceId: "w1", userId: "u1", botId: "botA", skillKey: "user:not for a", enabled: false },
      update: {},
    });

    const forA = await listAgentSkillRecords(prisma as never, { spaceId: "w1", userId: "u1", botId: "botA" });
    expect(forA.map((s) => s.name)).toEqual(["Everyone", "Only bot A"]);
    const forB = await listAgentSkillRecords(prisma as never, { spaceId: "w1", userId: "u1", botId: "botB" });
    expect(forB.map((s) => s.name)).toEqual(["Everyone", "Not for A"]);
    const all = await listAgentSkillRecords(prisma as never, { spaceId: "w1", userId: "u1" });
    expect(all).toHaveLength(3);
    // skill_read follows the same visibility.
    expect(await skillReadFromTool(prisma as never, { spaceId: "w1", userId: "u1", botId: "botB" }, { name: "Only bot A" })).toEqual({ error: "Skill not found." });
  });

  it("scopes a bot-created skill to its creator", async () => {
    const owner = { spaceId: "w1", userId: "u1", botId: "botA" };
    const created = await skillCreateFromTool(prisma as never, owner, { name: "Mine", description: "d", body: "x" });
    expect(created.ok).toBe(true);
    expect(await prisma.skillSetting.findMany({ where: { skillKey: "user:mine" } })).toMatchObject([{ availability: "selected" }]);
    expect(await prisma.botSkill.findMany({ where: { skillKey: "user:mine" } })).toMatchObject([{ botId: "botA", enabled: true }]);
    expect((await listAgentSkillRecords(prisma as never, { ...owner, botId: "botB" })).map((s) => s.name)).toEqual([]);
    expect((await listAgentSkillRecords(prisma as never, owner)).map((s) => s.name)).toEqual(["Mine"]);
  });

  it("renames access rows with the skill and removes them on delete", async () => {
    const owner = { spaceId: "w1", userId: "u1", botId: "botA" };
    await skillCreateFromTool(prisma as never, owner, { name: "Old", description: "d", body: "x" });
    const renamed = await skillUpdateFromTool(prisma as never, owner, { name: "Old", newName: "New" });
    expect(renamed.ok).toBe(true);
    expect(await prisma.skillSetting.findMany({ where: { skillKey: "user:old" } })).toEqual([]);
    expect(await prisma.skillSetting.findMany({ where: { skillKey: "user:new" } })).toHaveLength(1);
    expect(await prisma.botSkill.findMany({ where: { skillKey: "user:new" } })).toHaveLength(1);
    expect((await listAgentSkillRecords(prisma as never, owner)).map((s) => s.name)).toEqual(["New"]);

    expect(await skillDeleteFromTool(prisma as never, owner, { name: "New" })).toEqual({ ok: true, name: "New" });
    expect(await prisma.skillSetting.findMany({})).toEqual([]);
    expect(await prisma.botSkill.findMany({})).toEqual([]);
  });
```

**Step 3: Run tests to verify they fail**

Run: `pnpm --filter @rakazo/adapters test -- skill-tools`
Expected: les 3 nouveaux tests FAIL (`forA` contient 3 skills ; pas de rows `skillSetting`), les anciens PASS.

**Step 4: Implémenter dans `skill-tools.ts`**

Imports : ajouter `asSkillAvailability, isSkillVisible, userSkillKey` à l'import `@rakazo/core`.

`SkillOwner` :

```ts
type SkillOwner = {
  spaceId: string;
  userId: string;
  /** When set, list/read/update/delete only see skills visible to this bot. */
  botId?: string;
};
```

`listAgentSkillRecords` :

```ts
export async function listAgentSkillRecords(
  prisma: PrismaClient,
  owner: SkillOwner,
): Promise<Array<SkillRecord & { id: string }>> {
  const rows = await prisma.agentSkill.findMany({
    where: { spaceId: owner.spaceId, userId: owner.userId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const records = rows.map(toRecord);
  const visible = owner.botId ? await onlyVisibleTo(prisma, owner, owner.botId, records) : records;
  return [...builtinRecords(), ...visible];
}

async function onlyVisibleTo<T extends { name: string }>(
  prisma: PrismaClient,
  owner: SkillOwner,
  botId: string,
  records: T[],
): Promise<T[]> {
  const [settings, overrides] = await Promise.all([
    prisma.skillSetting.findMany({ where: { spaceId: owner.spaceId, userId: owner.userId } }),
    prisma.botSkill.findMany({ where: { botId, spaceId: owner.spaceId, userId: owner.userId } }),
  ]);
  const availability = new Map(settings.map((s) => [s.skillKey, asSkillAvailability(s.availability)]));
  const override = new Map(overrides.map((o) => [o.skillKey, o.enabled]));
  return records.filter((record) => {
    const key = userSkillKey(record.name);
    return isSkillVisible({ availability: availability.get(key), override: override.get(key) });
  });
}
```

`skillCreateFromTool` : remplacer le `prisma.agentSkill.create` par

```ts
    const create = prisma.agentSkill.create({
      data: { spaceId: owner.spaceId, userId: owner.userId, name, description, content, source: "user" },
    });
    // A bot-created skill starts scoped to its creator (design Q2); the user widens it in the UI.
    const [row] = owner.botId
      ? await prisma.$transaction([
          create,
          prisma.skillSetting.upsert({
            where: { spaceId_userId_skillKey: { spaceId: owner.spaceId, userId: owner.userId, skillKey: userSkillKey(name) } },
            create: { spaceId: owner.spaceId, userId: owner.userId, skillKey: userSkillKey(name), availability: "selected" },
            update: { availability: "selected" },
          }),
          prisma.botSkill.upsert({
            where: { botId_skillKey: { botId: owner.botId, skillKey: userSkillKey(name) } },
            create: { spaceId: owner.spaceId, userId: owner.userId, botId: owner.botId, skillKey: userSkillKey(name), enabled: true },
            update: { enabled: true },
          }),
        ])
      : [await create];
```

et adapter le `hint` : `Created skill for this agent. Mention /${row.name} so the user can open it; they can share it with other agents from its settings.`

`skillUpdateFromTool` : remplacer le bloc `try { const updated = await prisma.agentSkill.updateMany(...) ... }` par

```ts
  try {
    const oldKey = userSkillKey(existing.name);
    const newKey = userSkillKey(nextName);
    const scope = { spaceId: owner.spaceId, userId: owner.userId };
    const [updated] = await prisma.$transaction([
      prisma.agentSkill.updateMany({
        where: { id: existing.id, ...scope, source: "user" },
        data: { name: nextName, description: nextDescription, content: nextContent },
      }),
      // Rename cascade: access rows follow the skill's key.
      ...(oldKey !== newKey
        ? [
            prisma.skillSetting.updateMany({ where: { ...scope, skillKey: oldKey }, data: { skillKey: newKey } }),
            prisma.botSkill.updateMany({ where: { ...scope, skillKey: oldKey }, data: { skillKey: newKey } }),
          ]
        : []),
    ]);
    if (updated.count !== 1) return { error: "Could not update skill." };
    return { ok: true, id: existing.id, name: nextName, description: nextDescription };
  } catch {
    return { error: "Could not update skill." };
  }
```

`skillDeleteFromTool` : remplacer `const deleted = await prisma.agentSkill.deleteMany(...)` par

```ts
  const scope = { spaceId: owner.spaceId, userId: owner.userId };
  const skillKey = userSkillKey(existing.name);
  const [deleted] = await prisma.$transaction([
    prisma.agentSkill.deleteMany({ where: { id: existing.id, ...scope, source: "user" } }),
    prisma.skillSetting.deleteMany({ where: { ...scope, skillKey } }),
    prisma.botSkill.deleteMany({ where: { ...scope, skillKey } }),
  ]);
```

Note : `updateMany` sur `skillSetting.skillKey` peut lever P2002 si une ligne dangling porte déjà `newKey` (impossible en pratique grâce au GC au delete ; le `catch` renvoie « Could not update skill. » — acceptable phase 1).

**Step 5: Run tests to verify they pass**

Run: `pnpm --filter @rakazo/adapters test -- skill-tools && pnpm --filter @rakazo/adapters check`
Expected: tous PASS (anciens + 3 nouveaux). `check` peut échouer sur `executor.ts` ? Non — `botId` est optionnel, les appels existants compilent. Doit passer.

**Step 6: Commit**

```bash
git add packages/adapters/src/skill-tools.ts packages/adapters/src/skill-tools.test.ts
git commit -m "adapters: scope skill tools and catalog by bot visibility

skill_create now scopes a new skill to its creator; renames cascade to the
access rows and deletes clean them up in the same transaction.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 5 : executor — passer `botId` partout + description `skill_create`

**Files:**
- Modify: `packages/adapters/src/executor.ts` (~L677 routine, ~L914 run, ~L2284-2345 tool dispatch)
- Modify: `packages/adapters/src/builtin-tools.ts` (~L501-503 description `skill_create`)

**Step 1: Routine (L677)**

```ts
      const skillRecords = await listAgentSkillRecords(deps.prisma, {
        spaceId: routine.spaceId,
        userId: routine.userId,
        botId: routine.botId,
      });
```

**Step 2: Run (L914)**

```ts
          listAgentSkillRecords(deps.prisma, {
            spaceId: run.spaceId,
            userId: run.userId,
            botId: run.botId,
          }),
```

**Step 3: Tools (L2284-2345)** — dans les 4 blocs `skill_read` / `skill_create` / `skill_update` / `skill_delete`, l'objet owner devient

```ts
              {
                spaceId: run.spaceId,
                userId: run.userId,
                botId: run.botId,
              },
```

Vérifier avec : `grep -n "userId: run.userId," packages/adapters/src/executor.ts | sed -n '1,12p'` puis `sed -n '2280,2350p'` — 4 occurrences dans la zone skill_* doivent avoir `botId: run.botId`.

**Step 4: Description `skill_create`** (`builtin-tools.ts` ~L501) — remplacer la phrase fausse « The Pi runtime already understands this format; we persist and inject them. » par :

```
Create a reusable Claude Agent Skill (generic how-to SKILL.md). It is persisted and injected into your prompt; new skills are visible to this agent only until the user shares them with other agents. Use when a multi-step task is worth repeating or the user asks to save a skill. Do not include account names, channels, or inboxes — those belong in a routine.
```

**Step 5: Vérifier**

Run: `pnpm --filter @rakazo/adapters check && pnpm --filter @rakazo/adapters test`
Expected: OK, tous les tests adapters PASS (dont `executor.test.ts` — si un test mocke `listAgentSkillRecords` avec une assertion `toHaveBeenCalledWith({spaceId, userId})`, ajouter `botId` à l'attendu).

**Step 6: Commit**

```bash
git add packages/adapters/src/executor.ts packages/adapters/src/builtin-tools.ts
git commit -m "adapters: resolve agent skills per bot at run, routine and tool time

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 6 : API — service `agentSkills` (access), router, `bots.duplicate`, routine test-run

**Files:**
- Modify: `apps/api/src/agent-skills.ts`
- Modify: `apps/api/src/router.ts` (~L695-730 `bots.duplicate`, ~L2131 `routines.test`, ~L2286-2300 `agentSkills`)

Pas de test unitaire API (mock `$transaction` interactif lourd) : la logique de visibilité est testée en core/adapters ; le mapping API est couvert par l'e2e Task 8.

**Step 1: Service — imports et types**

```ts
import type { Actor, AgentSkill, AgentSkillCatalogEntry, AgentSkillSource } from "@rakazo/contracts";
import {
  asSkillAvailability,
  buildSkillMd,
  isSkillReadOnly,
  isSkillVisible,
  parseSkillMd,
  userSkillKey,
  type SkillSource,
} from "@rakazo/core";
```

**Step 2: Service — `list` / `listWithContent` avec accès**

Remplacer les méthodes `list` et `listWithContent` par un helper interne + deux wrappers :

```ts
  type Access = Pick<AgentSkillCatalogEntry, "availability" | "visibleBotIds">;

  /** Resolve availability + visible bots for every skill of the owner in 3 queries. */
  async function accessIndex(actor: Actor): Promise<{
    bots: string[];
    of: (name: string) => Access;
  }> {
    const scope = { spaceId: actor.spaceId, userId: actor.userId };
    const [bots, settings, overrides] = await Promise.all([
      prisma.bot.findMany({ where: { ...scope, archivedAt: null }, select: { id: true }, orderBy: { position: "asc" } }),
      prisma.skillSetting.findMany({ where: scope }),
      prisma.botSkill.findMany({ where: scope }),
    ]);
    const availability = new Map(settings.map((s) => [s.skillKey, asSkillAvailability(s.availability)]));
    const override = new Map(overrides.map((o) => [`${o.botId}\n${o.skillKey}`, o.enabled]));
    const botIds = bots.map((bot) => bot.id);
    return {
      bots: botIds,
      of(name) {
        const key = userSkillKey(name);
        const skillAvailability = availability.get(key) ?? "all";
        return {
          availability: skillAvailability,
          visibleBotIds: botIds.filter((botId) =>
            isSkillVisible({ availability: skillAvailability, override: override.get(`${botId}\n${key}`) }),
          ),
        };
      },
    };
  }

  async function catalog(actor: Actor, botId?: string): Promise<Array<AgentSkill & Access>> {
    const [rows, access] = await Promise.all([
      prisma.agentSkill.findMany({
        where: { spaceId: actor.spaceId, userId: actor.userId },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      }),
      accessIndex(actor),
    ]);
    const builtins = builtinCatalog().map((skill) => ({
      ...skill,
      availability: "all" as const,
      visibleBotIds: access.bots,
    }));
    const users = rows.map((row) => ({ ...mapAgentSkill(row), ...access.of(row.name) }));
    const entries = [...builtins, ...users];
    return botId ? entries.filter((entry) => entry.visibleBotIds.includes(botId)) : entries;
  }
```

puis dans l'objet retourné :

```ts
    async list(actor: Actor, input?: { botId?: string }): Promise<AgentSkillCatalogEntry[]> {
      return (await catalog(actor, input?.botId)).map(({ content: _content, ...entry }) => entry);
    },

    async listWithContent(actor: Actor, botId?: string): Promise<AgentSkill[]> {
      return catalog(actor, botId);
    },
```

**Step 3: Service — `setAccess`**

Ajouter après `remove` :

```ts
    async setAccess(
      actor: Actor,
      input: { skillId: string; availability?: "all" | "selected"; bot?: { botId: string; enabled: boolean } },
    ): Promise<AgentSkillCatalogEntry> {
      const existing = await owned(actor, input.skillId);
      const scope = { spaceId: actor.spaceId, userId: actor.userId };
      const skillKey = userSkillKey(existing.name);
      if (input.bot) {
        const bot = await prisma.bot.findFirst({ where: { id: input.bot.botId, ...scope }, select: { id: true } });
        if (!bot) throw new IsolationError();
      }
      await prisma.$transaction([
        ...(input.availability
          ? [
              prisma.skillSetting.upsert({
                where: { spaceId_userId_skillKey: { ...scope, skillKey } },
                create: { ...scope, skillKey, availability: input.availability },
                update: { availability: input.availability },
              }),
            ]
          : []),
        ...(input.bot
          ? [
              prisma.botSkill.upsert({
                where: { botId_skillKey: { botId: input.bot.botId, skillKey } },
                create: { ...scope, botId: input.bot.botId, skillKey, enabled: input.bot.enabled },
                update: { enabled: input.bot.enabled },
              }),
            ]
          : []),
      ]);
      const entry = (await this.list(actor)).find((skill) => skill.id === existing.id);
      if (!entry) throw new IsolationError();
      return entry;
    },
```

(`this.list` fonctionne car les méthodes sont appelées sur l'objet service ; si biome/tsc râle sur `this`, extraire `list` en fonction nommée `listCatalog` et l'appeler directement.)

**Step 4: Service — rename cascade dans `update`, GC dans `remove`**

Dans `update`, remplacer `const updated = await prisma.agentSkill.updateMany({...})` par :

```ts
        const scope = { spaceId: actor.spaceId, userId: actor.userId };
        const oldKey = userSkillKey(existing.name);
        const newKey = userSkillKey(resolved.name);
        const [updated] = await prisma.$transaction([
          prisma.agentSkill.updateMany({
            where: { id: existing.id, ...scope, source: "user" },
            data: { name: resolved.name, description: resolved.description, content: resolved.content },
          }),
          ...(oldKey !== newKey
            ? [
                prisma.skillSetting.updateMany({ where: { ...scope, skillKey: oldKey }, data: { skillKey: newKey } }),
                prisma.botSkill.updateMany({ where: { ...scope, skillKey: oldKey }, data: { skillKey: newKey } }),
              ]
            : []),
        ]);
```

Dans `remove`, remplacer `const deleted = await prisma.agentSkill.deleteMany({...})` par :

```ts
      const scope = { spaceId: actor.spaceId, userId: actor.userId };
      const skillKey = userSkillKey(existing.name);
      const [deleted] = await prisma.$transaction([
        prisma.agentSkill.deleteMany({ where: { id: existing.id, ...scope, source: "user" } }),
        prisma.skillSetting.deleteMany({ where: { ...scope, skillKey } }),
        prisma.botSkill.deleteMany({ where: { ...scope, skillKey } }),
      ]);
```

**Step 5: Router**

Bloc `agentSkills` (~L2286) :

```ts
    agentSkills: {
      list: authed.agentSkills.list.handler(async ({ context, input }) =>
        agentSkills.list(context.actor, input ?? undefined),
      ),
      get: /* inchangé */,
      create: /* inchangé */,
      update: /* inchangé */,
      remove: /* inchangé */,
      setAccess: authed.agentSkills.setAccess.handler(async ({ context, input }) =>
        agentSkills.setAccess(context.actor, input),
      ),
    },
```

`routines.test` (~L2131) :

```ts
        const skillRecords = await agentSkills.listWithContent(context.actor, routine.botId);
```

`bots.duplicate` (~L717, après le bloc `botMcpServer.createMany`) :

```ts
        const skillAccess = await deps.prisma.botSkill.findMany({
          where: { botId: source.id, spaceId: context.actor.spaceId, userId: context.actor.userId },
        });
        if (skillAccess.length) {
          await deps.prisma.botSkill.createMany({
            data: skillAccess.map((row) => ({
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              botId: duplicate.id,
              skillKey: row.skillKey,
              enabled: row.enabled,
            })),
          });
        }
```

**Step 6: Vérifier**

Run: `pnpm --filter @rakazo/api check && pnpm --filter @rakazo/api test`
Expected: tsc OK, tests API PASS (si `router.test.ts` snapshotte la liste des procédures, mettre à jour le snapshot après lecture du diff : `pnpm --filter @rakazo/api test -- -u` puis relire).

**Step 7: Commit**

```bash
git add apps/api/src/agent-skills.ts apps/api/src/router.ts
git commit -m "api: per-bot skill access on agentSkills, cascade on rename/delete, copy on duplicate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 7 : Web — slash picker filtré par bot, chips agents + disponibilité dans `KnowledgeSection`

**Files:**
- Modify: `apps/web/src/pages/Shell.tsx` (~L998-1018)
- Modify: `apps/web/src/pages/KnowledgeSection.tsx` (composant `AgentSkills`, ~L239-400)

**Step 1: Shell — le picker ne liste que les skills du bot actif**

Les deux appels `rpc.agentSkills.list()` (effet de montage L1000 et `refreshAgentSkills` L1014) deviennent :

```ts
rpc.agentSkills.list({ botId: activeBotId.current })
```

(`activeBotId` est un `useRef` déclaré L568, avant ces hooks ; `undefined` en groupe → liste complète, comportement actuel.)

**Step 2: KnowledgeSection — props et état**

`KnowledgeSection` passe déjà `botId` ; rendre `<AgentSkills botId={botId} />` (L58) et changer la signature :

```tsx
function AgentSkills({ botId }: { botId: string }) {
```

Imports : ajouter `Bot` au type import `@rakazo/contracts`, `Button` depuis `@rakazo/ui-web`, `Check` depuis `lucide-react` (mêmes imports que `McpServersOverlay.tsx`).

État supplémentaire :

```tsx
  const [bots, setBots] = useState<Bot[]>([]);
```

Dans l'effet de montage existant, charger les bots en parallèle (remplacer `void rpc.agentSkills.list().then(...)`) :

```tsx
    void Promise.all([rpc.agentSkills.list(), rpc.bots.list()])
      .then(([list, allBots]) => {
        if (current !== generation.current) return;
        setSkills(list);
        setBots(allBots.filter((bot) => !bot.archivedAt));
      })
```

(le `.catch` existant reste : `setSkills([])` + erreur.)

**Step 3: KnowledgeSection — handler d'accès**

```tsx
  async function setAccess(
    entry: AgentSkillCatalogEntry,
    patch: { availability?: "all" | "selected"; bot?: { botId: string; enabled: boolean } },
  ) {
    setError(null);
    try {
      const updated = await rpc.agentSkills.setAccess({ skillId: entry.id, ...patch });
      setSkills((list) => list.map((skill) => (skill.id === updated.id ? updated : skill)));
    } catch {
      setError(t`Could not update agent access`);
    }
  }
```

**Step 4: KnowledgeSection — rendu**

La liste (L57-80 dans le rendu, `skills.map((entry) => <button ...>)`) : le `<button>` ligne devient un `<div>` conteneur avec le bouton nom/description à l'intérieur, puis une rangée de chips pour les skills éditables. Pas de boutons imbriqués.

```tsx
      {!editorOpen
        ? skills.map((entry) => (
            <div key={entry.id} className="rounded-[11px] hover:bg-muted" data-testid="bot-knowledge-skill">
              <button
                type="button"
                onClick={() => void openSkill(entry)}
                className="w-full rounded-[11px] px-2.5 pt-2.5 pb-1 text-start"
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-[14px] text-foreground" dir="auto">
                    {entry.name}
                  </span>
                  {entry.readOnly ? (
                    <span className="shrink-0 text-[12px] text-muted-foreground/80">
                      <Trans>read-only</Trans>
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground/80" dir="auto">
                  {entry.description}
                </span>
              </button>
              {entry.readOnly ? null : (
                <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5">
                  <Button
                    type="button"
                    variant={entry.availability === "all" ? "default" : "outline"}
                    size="xs"
                    className="rounded-full"
                    aria-pressed={entry.availability === "all"}
                    onClick={() =>
                      void setAccess(entry, {
                        availability: entry.availability === "all" ? "selected" : "all",
                      })
                    }
                  >
                    {entry.availability === "all" ? <Check aria-hidden="true" /> : null}
                    <Trans>All agents</Trans>
                  </Button>
                  {bots.map((bot) => {
                    const visible = entry.visibleBotIds.includes(bot.id);
                    return (
                      <Button
                        key={bot.id}
                        type="button"
                        variant={visible ? "default" : "outline"}
                        size="xs"
                        className="rounded-full"
                        aria-pressed={visible}
                        aria-label={bot.name}
                        onClick={() =>
                          void setAccess(entry, { bot: { botId: bot.id, enabled: !visible } })
                        }
                      >
                        {visible ? <Check aria-hidden="true" /> : null}
                        {bot.name}
                        {bot.id === botId ? <span className="sr-only"> (this agent)</span> : null}
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>
          ))
        : null}
```

Sémantique : « All agents » bascule `availability` ; un chip bot écrit un override `enabled` (exclusion sous `all`, inclusion sous `selected`). L'état rendu vient de `visibleBotIds` calculé serveur, donc toujours cohérent avec le runtime.

**Step 5: Lingui**

Run: `pnpm --filter @rakazo/web exec lingui extract`
Expected: nouvelles clés `All agents`, `Could not update agent access` ajoutées dans les catalogues (vérifier `git status apps/web/src/locales`). Si le repo a un script dédié (`grep -n lingui apps/web/package.json`), l'utiliser.

**Step 6: Vérifier**

Run: `pnpm --filter @rakazo/web check && pnpm --filter @rakazo/web test && pnpm lint`
Expected: OK. Si biome reformate, `pnpm format` puis relancer.

Vérif visuelle rapide (stack compose up) : ouvrir un bot → Settings → Advanced → Knowledge → Skills : chaque skill utilisateur montre « All agents » actif + tous les chips actifs ; cliquer un chip → il passe outline ; recharger → état conservé ; `/` dans le composer de ce bot → la skill exclue n'apparaît plus.

**Step 7: Commit**

```bash
git add apps/web/src/pages/Shell.tsx apps/web/src/pages/KnowledgeSection.tsx apps/web/src/locales
git commit -m "web: agent chips and availability toggle on skills, bot-scoped slash picker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 8 : E2E — scoping visible dans le panneau et dans le picker

**Files:**
- Modify: `apps/web/e2e/knowledge-panel.spec.ts` (~L80-120, bloc Skills)

**Step 1: Étendre le bloc Skills**

Juste après `await captureScreenshot(page, testInfo, "82-knowledge-skill-listed");` et avant `await skillRow.click();`, insérer :

```ts
  // Scoping: a hand-made skill is visible to every agent; excluding Chief hides it
  // from Chief's catalog and slash picker without touching the skill itself.
  type CatalogEntry = { id: string; name: string; availability: string; visibleBotIds: string[] };
  const listFor = (botId?: string) =>
    rpc<CatalogEntry[]>(page, "agentSkills/list", botId ? { botId } : undefined);
  const before = (await listFor()).find((entry) => entry.name === "greet-politely");
  expect(before?.availability).toBe("all");
  expect(before?.visibleBotIds).toContain(chiefId);

  const skillCard = knowledge.getByTestId("bot-knowledge-skill").filter({ hasText: "greet-politely" });
  const chiefChip = skillCard.getByRole("button", { name: "Chief", exact: true });
  await expect(chiefChip).toHaveAttribute("aria-pressed", "true");
  await chiefChip.click();
  await expect(chiefChip).toHaveAttribute("aria-pressed", "false");
  await captureScreenshot(page, testInfo, "82b-knowledge-skill-scoped");
  await expect
    .poll(async () => (await listFor(chiefId)).some((entry) => entry.name === "greet-politely"))
    .toBe(false);
  expect((await listFor()).some((entry) => entry.name === "greet-politely")).toBe(true);

  // Rename keeps the exclusion (access rows follow the key).
  const skillId = before?.id;
  expect(skillId).toBeTruthy();
  await rpc(page, "agentSkills/update", { skillId, name: "greet-warmly" });
  expect((await listFor(chiefId)).some((entry) => entry.name === "greet-warmly")).toBe(false);
  expect((await listFor()).some((entry) => entry.name === "greet-warmly")).toBe(true);
  await rpc(page, "agentSkills/update", { skillId, name: "greet-politely" });
  await chiefChip.click();
  await expect(chiefChip).toHaveAttribute("aria-pressed", "true");
```

Remarques :
- `chiefId` existe déjà plus bas dans ce spec (bloc Files) ; le déclarer avant le bloc Skills si besoin (`grep -n "chiefId" apps/web/e2e/knowledge-panel.spec.ts`).
- Vérifier la forme exacte de l'input `agentSkills/update` (`grep -n "update:" -A 8 packages/contracts/src/rpc.ts` dans le bloc agentSkills) : si seul `content` est accepté, passer un SKILL.md complet avec le nouveau `name` via `buildSkillMd`-like string.
- Le nom du bot par défaut est « Chief » (cf. `completeOnboarding`).

**Step 2: Lancer**

Run: `pnpm --filter @rakazo/web e2e knowledge-panel`
Expected: PASS. Les screenshots `82b-knowledge-skill-scoped` apparaissent dans le dossier de sortie.

Run aussi : `pnpm --filter @rakazo/web e2e slash-skills`
Expected: PASS inchangé (skill créée via RPC = `all` → visible dans le picker).

**Step 3: Commit**

```bash
git add apps/web/e2e/knowledge-panel.spec.ts
git commit -m "e2e: cover per-bot skill scoping from the knowledge panel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 9 : passe finale

**Step 1: Vérifs globales**

Run: `pnpm lint && pnpm check && pnpm test`
Expected: tout vert. Corriger + amender/commiter si besoin.

**Step 2: Design doc**

Dans `docs/plans/2026-09-03-skills-system-design.md`, §5 Phasage, ligne Phase 1 : ajouter `— plan : docs/plans/2026-09-05-skills-scoping-phase1.md ; livré <hash du dernier commit>`. Noter la simplification « pas de section Skills séparée dans BotSettings ».

```bash
git add docs/plans/2026-09-03-skills-system-design.md
git commit -m "docs: link phase 1 scoping plan from skills v2 design

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

**Step 3: Push (fork uniquement)**

```bash
git push romainjeff main
```

Ne pas pousser sur `origin`.

---

## Hors périmètre phase 1 (rappel)

- Marketplaces / `SpaceMarketplace`, clés `mkt:` (phase 3).
- Skills filesystem-first / mount RO (phase 2).
- Avertissement UI cap 50 (Q7) — à faire quand un espace approche du cap.
- Tests unitaires du service API (`agent-skills.ts`) : couverts par e2e + core/adapters ; à ajouter si le service grossit en phase 3.
