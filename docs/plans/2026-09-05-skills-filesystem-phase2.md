# Skills v2 — Phase 2 : Filesystem-first — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Le contenu des skills user vit dans `DATA_DIR/skills/user/<spaceId>/<userId>/<dir>/SKILL.md` ; la DB ne garde que `SkillSetting` / `BotSkill` ; les rows `agent_skills` existantes sont exportées une fois au boot de l'API puis supprimées.

**Architecture:** Un module FS unique `packages/adapters/src/skill-store.ts` (`listUserSkills`, `writeUserSkill`, `removeUserSkill`, `userSkillsRoot`, `skillDirName`) devient la source de vérité du contenu. Les deux seuls consommateurs de `prisma.agentSkill` — `packages/adapters/src/skill-tools.ts` (tools `skill_*` + `listAgentSkillRecords`) et `apps/api/src/agent-skills.ts` (service oRPC) — sont réécrits dessus ; ils gardent la logique phase 1 (visibilité, rename cascade, GC des rows d'accès). L'**id** d'une skill user devient son `skillKey` (`user:<lower(name)>`) : le contrat `Id = z.string().min(1)` l'accepte, donc **aucun changement de contrat** ni d'e2e. Le modèle Prisma `AgentSkill` reste dans le schéma cette phase (l'export tourne au boot de l'API, or `prisma migrate deploy` tourne **avant** le boot dans compose → un `DROP TABLE` dans la même release perdrait les données). Le drop passe en phase 3. Design : `docs/plans/2026-09-03-skills-system-design.md` §3.

**Tech Stack:** pnpm monorepo, TypeScript, `node:fs/promises`, Prisma 7, oRPC + zod, React + lingui, vitest, Playwright.

**Conventions repo :**
- Tests unitaires : `pnpm --filter <pkg> test` (vitest, mocks Prisma à la main). Typecheck : `pnpm --filter <pkg> check`. Lint sur fichiers touchés : `pnpm exec biome check <paths>` (le `pnpm lint` racine a 5 échecs préexistants sans rapport).
- E2E : `pnpm test:e2e -- --spec=<name>` (Docker requis : Testcontainers Postgres + API in-process + Playwright). Le harness fixe `DATA_DIR` sous `test-report/…/data`.
- Worktree neuf : `pnpm install --frozen-lockfile --prefer-offline` puis `pnpm --filter @rakazo/db exec prisma generate` avant tout test.
- Commits : trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. **Ne jamais pousser sur `origin`** (elie222/rakazo) ; pousser sur `romainjeff` : `git push romainjeff main`.
- Ne pas toucher `docs/plans/2026-09-05-channels.md` (untracked, pas à nous). Ne pas changer la branche du checkout principal `~/workspace/rakazo-bot` : worktrees pour le travail parallèle.

**Décisions phase 2 (tranchées, ne pas rouvrir) :**
- **Id = skillKey.** `AgentSkill.id` renvoyé par l'API et les tools = `userSkillKey(name)`. Un rename change l'id (le front rafraîchit la liste après save, il ne garde pas l'ancien id). Builtins gardent `builtin:<name>`.
- **Nom de dossier = `encodeURIComponent(lower(trim(name)))`** (+ garde `.`/`..`). Bijectif, FS-safe, dérivé de la même clé que `SkillSetting`/`BotSkill` → unicité case-insensitive gratuite. Le `name` affiché vient toujours du frontmatter, jamais du nom de dossier. `ponytail: slug lisible = table de collisions, pas maintenant`.
- **Pas de cache mtime** (design §3 le propose). Un run lit ~dizaines de fichiers ; `readdir`+`readFile` suffisent. `ponytail: cache mtime si latence mesurée`.
- **Unicité à la création = `writeFile(..., { flag: "wx" })`** (EEXIST ⇒ conflit). Remplace l'index unique DB.
- **Update = écriture atomique** (`tmp` + `rename`) : un crash mi-écriture ne laisse jamais un SKILL.md tronqué. Rename de skill = écrire le nouveau dossier (`wx`), cascader les rows d'accès, supprimer l'ancien dossier — dans cet ordre.
- **Delete = fichier d'abord, rows ensuite.** Rows orphelines tolérées (design : « GC rows pendantes ») ; l'inverse (rows supprimées, fichier encore là) élargirait la visibilité à `all` par défaut.
- **`createdAt = updatedAt = mtime`** du SKILL.md. `ponytail: birthtime n'est pas stable après un rename atomique`.
- **Fichier invalide** (frontmatter KO) → ignoré + `console.warn`, jamais de crash de run. Pas de warning dans le panneau cette phase. `ponytail: warning UI quand un user tombe dessus`.
- **Export au boot de l'API uniquement** (`apps/api/src/app.ts`), idempotent : chaque row écrite puis supprimée. Le worker partage le volume `appdata:/data` (`infra/compose/docker-compose.topology.yml`), il lit les fichiers sans rien exporter. Toutes les rows sont exportées quelle que soit `source` (aucun writer de rows `plugin` n'existe).
- **Suppression de compte** : `beforeDeleteUser` (`apps/api/src/app.ts`) supprime `skills/user/*/<userId>`.
- **Éditeur** : validation live via `parseSkillMd` dans `KnowledgeSection > AgentSkills` ; Save désactivé + message si invalide. Pas de test unitaire web dédié (rendu direct d'un helper déjà testé dans `@rakazo/core`).
- Marketplaces, `scripts/`, mount sandbox, `skill_list` : phase 3.

**Dépendances entre tâches :** 1 → {2, 3, 4}. 5 indépendante. 6 (docs + e2e) après tout. 2, 3, 4, 5 parallélisables en worktrees.

---

## Task 1 : `skill-store.ts` — store FS dans `@rakazo/adapters`

**Files:**
- Create: `packages/adapters/src/skill-store.ts`
- Create: `packages/adapters/src/skill-store.test.ts`
- Modify: `packages/adapters/src/index.ts` (ajouter `export * from "./skill-store.js";` après la ligne 75 `export * from "./skill-tools.js";`)

**Step 1: Write the failing test**

```ts
// packages/adapters/src/skill-store.test.ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSkillMd } from "@rakazo/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  isExists,
  listUserSkills,
  removeUserSkill,
  removeUserSkillDirs,
  skillDirName,
  userSkillsRoot,
  writeUserSkill,
} from "./skill-store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmpRoot() {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-skills-"));
  dirs.push(dir);
  return dir;
}

const md = (name: string, body = "Steps") =>
  buildSkillMd({ name, description: `About ${name}`, body });

describe("skill store", () => {
  it("scopes the root per space and user", () => {
    expect(userSkillsRoot("/data", { spaceId: "ws-1", userId: "user-1" })).toBe(
      path.join("/data", "skills", "user", "ws-1", "user-1"),
    );
  });

  it("derives a filesystem-safe directory name from the skill key", () => {
    expect(skillDirName("Daily Standup")).toBe("daily%20standup");
    expect(skillDirName("  Daily Standup ")).toBe(skillDirName("daily standup"));
    expect(skillDirName("a/b")).toBe("a%2Fb");
    expect(skillDirName(".")).toBe("%2E");
    expect(skillDirName("..")).toBe("%2E.");
  });

  it("returns an empty list when the root does not exist", async () => {
    const root = path.join(await tmpRoot(), "missing");
    expect(await listUserSkills(root)).toEqual([]);
  });

  it("writes, lists, replaces and removes skills", async () => {
    const root = await tmpRoot();
    await writeUserSkill(root, { name: "Daily Standup", content: md("Daily Standup") }, "create");
    await writeUserSkill(root, { name: "Alpha", content: md("Alpha") }, "create");

    const listed = await listUserSkills(root);
    expect(listed.map((s) => s.name)).toEqual(["Alpha", "Daily Standup"]);
    expect(listed[1]).toMatchObject({
      id: "user:daily standup",
      description: "About Daily Standup",
      source: "user",
      readOnly: false,
    });
    expect(listed[1]?.content).toBe(md("Daily Standup"));
    expect(listed[1]?.updatedAt).toBeInstanceOf(Date);

    await writeUserSkill(root, { name: "Alpha", content: md("Alpha", "New") }, "replace");
    expect((await listUserSkills(root)).find((s) => s.name === "Alpha")?.content).toBe(
      md("Alpha", "New"),
    );
    expect(await readFile(path.join(root, "alpha", "SKILL.md"), "utf8")).toBe(md("Alpha", "New"));

    await removeUserSkill(root, "alpha");
    expect((await listUserSkills(root)).map((s) => s.name)).toEqual(["Daily Standup"]);
  });

  it("refuses to create over an existing skill, case-insensitively", async () => {
    const root = await tmpRoot();
    await writeUserSkill(root, { name: "Alpha", content: md("Alpha") }, "create");
    const error = await writeUserSkill(
      root,
      { name: "ALPHA", content: md("ALPHA") },
      "create",
    ).catch((e: unknown) => e);
    expect(isExists(error)).toBe(true);
    expect(isExists(new Error("nope"))).toBe(false);
  });

  it("skips directories without a valid SKILL.md", async () => {
    const root = await tmpRoot();
    await writeUserSkill(root, { name: "Good", content: md("Good") }, "create");
    await mkdir(path.join(root, "empty"));
    await mkdir(path.join(root, "broken"));
    await writeFile(path.join(root, "broken", "SKILL.md"), "no frontmatter", "utf8");
    await writeFile(path.join(root, "stray.txt"), "x", "utf8");
    expect((await listUserSkills(root)).map((s) => s.name)).toEqual(["Good"]);
  });

  it("removes a user's skills across every space on account deletion", async () => {
    const dataDir = await tmpRoot();
    const a = userSkillsRoot(dataDir, { spaceId: "ws-1", userId: "user-1" });
    const b = userSkillsRoot(dataDir, { spaceId: "ws-2", userId: "user-1" });
    const other = userSkillsRoot(dataDir, { spaceId: "ws-1", userId: "user-2" });
    for (const root of [a, b, other]) {
      await writeUserSkill(root, { name: "Alpha", content: md("Alpha") }, "create");
    }
    await removeUserSkillDirs(dataDir, "user-1");
    expect(await listUserSkills(a)).toEqual([]);
    expect(await listUserSkills(b)).toEqual([]);
    expect((await listUserSkills(other)).map((s) => s.name)).toEqual(["Alpha"]);
    await expect(removeUserSkillDirs(path.join(dataDir, "nope"), "user-1")).resolves.toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @rakazo/adapters exec vitest run --root ../.. packages/adapters/src/skill-store.test.ts`
Expected: FAIL — `Cannot find module './skill-store.js'`.

**Step 3: Write minimal implementation**

```ts
// packages/adapters/src/skill-store.ts
/**
 * Skills v2 phase 2: user skill content lives on disk, the DB only keeps access rows
 * (SkillSetting / BotSkill). One directory per skill under
 * DATA_DIR/skills/user/<spaceId>/<userId>/<dir>/SKILL.md. spaceId/userId are DB cuids
 * (trusted); the skill directory name is derived from the skill key, never from user input
 * directly, so no path can escape the owner's root.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseSkillMd, type SkillRecord, userSkillKey } from "@rakazo/core";

export type UserSkillFile = SkillRecord & {
  id: string;
  source: "user";
  readOnly: false;
  createdAt: Date;
  updatedAt: Date;
};

export function userSkillsRoot(
  dataDir: string,
  owner: { spaceId: string; userId: string },
): string {
  return path.join(dataDir, "skills", "user", owner.spaceId, owner.userId);
}

/** Directory name: same identity as SkillSetting/BotSkill (lower(name)), made FS-safe. */
// ponytail: URL-encoding is bijective and safe on every FS; readable slugs need a collision table.
export function skillDirName(name: string): string {
  const key = userSkillKey(name).slice("user:".length);
  return encodeURIComponent(key).replace(/^\./, "%2E");
}

function skillFile(root: string, name: string): string {
  return path.join(root, skillDirName(name), "SKILL.md");
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function isExists(error: unknown): boolean {
  return hasCode(error, "EEXIST");
}

export async function listUserSkills(root: string): Promise<UserSkillFile[]> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(root);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  const skills: UserSkillFile[] = [];
  for (const entry of entries) {
    const file = path.join(root, entry, "SKILL.md");
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) continue;
      throw error;
    }
    const parsed = parseSkillMd(content);
    if ("error" in parsed) {
      // ponytail: skipped + log; a panel warning waits for a real user hitting this.
      console.warn(`[skills] ignoring ${file}: ${parsed.error}`);
      continue;
    }
    const info = await stat(file);
    skills.push({
      id: userSkillKey(parsed.name),
      name: parsed.name,
      description: parsed.description,
      content,
      source: "user",
      readOnly: false,
      // ponytail: birthtime is not stable across atomic replaces; both stamps = mtime.
      createdAt: info.mtime,
      updatedAt: info.mtime,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * "create" fails with EEXIST when a skill with the same key exists (the FS is the uniqueness
 * guard the DB index used to be). "replace" writes tmp + rename so a crash never leaves a
 * half-written SKILL.md.
 */
export async function writeUserSkill(
  root: string,
  skill: { name: string; content: string },
  mode: "create" | "replace",
): Promise<void> {
  const file = skillFile(root, skill.name);
  await mkdir(path.dirname(file), { recursive: true });
  if (mode === "create") {
    await writeFile(file, skill.content, { encoding: "utf8", flag: "wx" });
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, skill.content, "utf8");
  await rename(tmp, file);
}

export async function removeUserSkill(root: string, name: string): Promise<void> {
  await rm(path.join(root, skillDirName(name)), { recursive: true, force: true });
}

/** Account deletion: a user's skills live under every space they belonged to. */
export async function removeUserSkillDirs(dataDir: string, userId: string): Promise<void> {
  const base = path.join(dataDir, "skills", "user");
  const spaces = await readdir(base).catch(() => [] as string[]);
  await Promise.all(
    spaces.map((spaceId) => rm(path.join(base, spaceId, userId), { recursive: true, force: true })),
  );
}
```

Puis dans `packages/adapters/src/index.ts`, après `export * from "./skill-tools.js";` :

```ts
export * from "./skill-store.js";
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @rakazo/adapters exec vitest run --root ../.. packages/adapters/src/skill-store.test.ts`
Expected: PASS (7 tests).

Run: `pnpm --filter @rakazo/adapters check && pnpm exec biome check packages/adapters/src/skill-store.ts packages/adapters/src/skill-store.test.ts packages/adapters/src/index.ts`
Expected: clean.

**Step 5: Commit**

```bash
git add packages/adapters/src/skill-store.ts packages/adapters/src/skill-store.test.ts packages/adapters/src/index.ts
git commit -m "feat(skills): filesystem store for user skills

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 2 : runtime — `skill-tools.ts` sur le FS + wiring executor

**Files:**
- Modify: `packages/adapters/src/skill-tools.ts` (réécriture des accès `prisma.agentSkill`)
- Modify: `packages/adapters/src/skill-tools.test.ts` (mock sans `agentSkill`, seed via FS)
- Modify: `packages/adapters/src/executor.ts:563` (`createRunExecutor`), call sites `:677`, `:915`, `:2286-2355`
- Modify: `packages/adapters/src/executor.test.ts` (7 mocks `agentSkill`, test « expands @skill mentions » :577)

### 2.1 — `skill-tools.ts`

**Step 1: Adapter le test**

Dans `packages/adapters/src/skill-tools.test.ts` :

1. Imports : ajouter `import { mkdtemp, rm } from "node:fs/promises"; import { tmpdir } from "node:os"; import path from "node:path";` et `import { listUserSkills, userSkillsRoot, writeUserSkill } from "./skill-store.js";` ; ajouter `afterEach` à l'import vitest.
2. Dans `makePrisma`, **supprimer** entièrement la propriété `agentSkill: {...}` et `_store`. Le paramètre `rows` disparaît (`function makePrisma()`). Garder `$transaction`, `skillSetting: table([])`, `botSkill: table([])`.
3. Remplacer le bloc `describe` setup :

```ts
const owner = { spaceId: "ws-1", userId: "user-1" };

describe("skill tools", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let dataDir: string;
  let deps: { prisma: ReturnType<typeof makePrisma>; dataDir: string };

  beforeEach(async () => {
    prisma = makePrisma();
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-skill-tools-"));
    deps = { prisma, dataDir };
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Seed a skill file the way the API/panel would (no access rows = visible to all). */
  const seed = (name: string, description: string, body = "", scope = owner) =>
    writeUserSkill(
      userSkillsRoot(dataDir, scope),
      { name, content: buildSkillMd({ name, description, body }) },
      "create",
    );
```

4. Partout : `xxxFromTool(prisma, owner, …)` → `xxxFromTool(deps, owner, …)` ; `listAgentSkillRecords(prisma, …)` → `listAgentSkillRecords(deps, …)`. Le cast `as unknown as PrismaClient` s'il existe s'applique à `deps.prisma`, sinon typer `deps` en `Parameters<typeof skillCreateFromTool>[0]`.
5. Tests qui seedaient des rows via `makePrisma([...])` → `await seed(...)`. Tests qui lisaient `prisma._store` → `await listUserSkills(userSkillsRoot(dataDir, owner))`.
6. « rejects update/delete for plugin and builtin skills » : il n'existe plus de row `plugin` (le FS ne produit que `source:"user"`). Garder uniquement la partie builtin (un builtin seedé via `BUILTIN_AGENT_SKILLS` si la liste n'est pas vide ; sinon tester qu'un `skillId: "builtin:x"` inconnu renvoie `Skill not found.`). Si le test perd toute substance, le supprimer avec un commentaire dans le message de commit.
7. Les assertions sur `id` : l'id devient `user:<lower name>`. Ex. `expect(created.id).toBe("user:daily standup")`. Après un rename via `newName`, l'id retourné est la nouvelle clé.
8. Ajouter un test :

```ts
  it("reports a conflict when two creators race on the same name", async () => {
    await seed("Alpha", "First");
    const result = await skillCreateFromTool(deps, owner, { name: "alpha", description: "Dup" });
    expect(result).toEqual({ error: 'A skill named "alpha" already exists.' });
  });

  it("tolerates access rows whose skill file is gone", async () => {
    prisma.skillSetting.upsert({
      where: { spaceId_userId_skillKey: { ...owner, skillKey: "user:ghost" } },
      create: { ...owner, skillKey: "user:ghost", availability: "selected" },
      update: {},
    });
    const records = await listAgentSkillRecords(deps, { ...owner, botId: "bot-1" });
    expect(records.map((r) => r.name)).toEqual([]);
  });
```

(Le premier passe déjà par le check `findOwnedSkill` case-insensitive ; il documente le comportement. Le message vient de `existing.name` si trouvé — adapter l'attendu à `"Alpha"` si l'implémentation garde ce chemin.)

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @rakazo/adapters exec vitest run --root ../.. packages/adapters/src/skill-tools.test.ts`
Expected: FAIL (typage `deps` / `prisma.agentSkill` undefined).

**Step 3: Réécrire `skill-tools.ts`**

Changements exacts :

```ts
// imports: retirer buildSkillMd? NON (toujours utilisé). Ajouter :
import {
  isExists,
  listUserSkills,
  removeUserSkill,
  userSkillsRoot,
  writeUserSkill,
} from "./skill-store.js";

export type SkillToolDeps = { prisma: PrismaClient; dataDir: string };
```

- Supprimer `AgentSkillRow`, `asSource`, `toRecord`.
- `listAgentSkillRecords(deps: SkillToolDeps, owner)` :

```ts
export async function listAgentSkillRecords(
  deps: SkillToolDeps,
  owner: SkillOwner,
): Promise<Array<SkillRecord & { id: string }>> {
  const records = await listUserSkills(userSkillsRoot(deps.dataDir, owner));
  const visible = owner.botId
    ? await onlyVisibleTo(deps.prisma, owner, owner.botId, records)
    : records;
  return [...builtinRecords(), ...visible];
}
```

- `findOwnedSkill(deps, owner, input)` : même corps, appelle `listAgentSkillRecords(deps, owner)`.
- `skillReadFromTool(deps, owner, input)` : inchangé sauf signature.
- `skillCreateFromTool(deps, owner, input)` : remplacer tout le bloc `try { const create = prisma.agentSkill.create(...) ... }` par :

```ts
  const root = userSkillsRoot(deps.dataDir, owner);
  try {
    await writeUserSkill(root, { name, content }, "create");
  } catch (error) {
    return {
      error: isExists(error)
        ? `A skill named "${name}" already exists.`
        : "Could not create skill.",
    };
  }
  const skillKey = userSkillKey(name);
  if (owner.botId) {
    // A bot-created skill starts scoped to its creator (design Q2); the user widens it in the UI.
    // API/panel creation (no botId) stays "all agents": no access rows.
    const scope = { spaceId: owner.spaceId, userId: owner.userId };
    await deps.prisma.$transaction([
      deps.prisma.skillSetting.upsert({
        where: { spaceId_userId_skillKey: { ...scope, skillKey } },
        create: { ...scope, skillKey, availability: "selected" },
        update: { availability: "selected" },
      }),
      deps.prisma.botSkill.upsert({
        where: { botId_skillKey: { botId: owner.botId, skillKey } },
        create: { ...scope, botId: owner.botId, skillKey, enabled: true },
        update: { enabled: true },
      }),
    ]);
  }
  return {
    ok: true,
    id: skillKey,
    name,
    description,
    hint: owner.botId
      ? `Created skill, available to this agent. Mention /${name} so the user can open it; they can share it with other agents from its settings.`
      : `Created skill. Mention /${name} so the user can open it.`,
  };
```

- `skillUpdateFromTool(deps, owner, input)` : garder toute la résolution `nextName/nextDescription/nextContent` + clash check. Remplacer le `try { prisma.$transaction([agentSkill.updateMany, ...]) }` par :

```ts
  const root = userSkillsRoot(deps.dataDir, owner);
  const scope = { spaceId: owner.spaceId, userId: owner.userId };
  const oldKey = userSkillKey(existing.name);
  const newKey = userSkillKey(nextName);
  try {
    if (oldKey === newKey) {
      await writeUserSkill(root, { name: nextName, content: nextContent }, "replace");
    } else {
      // Rename: new file first, then access rows follow the key, then the old file goes.
      await writeUserSkill(root, { name: nextName, content: nextContent }, "create");
      await deps.prisma.$transaction([
        deps.prisma.skillSetting.updateMany({
          where: { ...scope, skillKey: oldKey },
          data: { skillKey: newKey },
        }),
        deps.prisma.botSkill.updateMany({
          where: { ...scope, skillKey: oldKey },
          data: { skillKey: newKey },
        }),
      ]);
      await removeUserSkill(root, existing.name);
    }
  } catch (error) {
    return {
      error: isExists(error)
        ? `A skill named "${nextName}" already exists.`
        : "Could not update skill.",
    };
  }
  return { ok: true, id: newKey, name: nextName, description: nextDescription };
```

- `skillDeleteFromTool(deps, owner, input)` :

```ts
  const scope = { spaceId: owner.spaceId, userId: owner.userId };
  const skillKey = userSkillKey(existing.name);
  // File first, rows second: orphan rows are harmless, a row-less file would widen to "all".
  await removeUserSkill(userSkillsRoot(deps.dataDir, owner), existing.name);
  await deps.prisma.$transaction([
    deps.prisma.skillSetting.deleteMany({ where: { ...scope, skillKey } }),
    deps.prisma.botSkill.deleteMany({ where: { ...scope, skillKey } }),
  ]);
  return { ok: true, name: existing.name };
```

**Step 4: Run test**

Run: `pnpm --filter @rakazo/adapters exec vitest run --root ../.. packages/adapters/src/skill-tools.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/adapters/src/skill-tools.ts packages/adapters/src/skill-tools.test.ts
git commit -m "feat(skills): skill_* tools read and write SKILL.md files

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### 2.2 — executor

**Step 1: Adapter `executor.test.ts`**

- Supprimer les 7 propriétés `agentSkill: {...}` des mocks Prisma (lignes ~401, 473, 540, 614, 677, 735, 907). Sans `dataDir`, l'executor lit `./data/skills/user/ws-1/user-1` → inexistant → `[]`, identique à l'ancien `findMany → []`.
- Test « expands @skill mentions in the routine prompt at fire time » (:577) : le mock `agentSkill.findMany` renvoyait une row `Daily standup` avec `skillContent`. Remplacer par un fichier :

```ts
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-executor-skills-"));
    await writeUserSkill(
      userSkillsRoot(dataDir, { spaceId: "ws-1", userId: "user-1" }),
      { name: "Daily standup", content: skillContent },
      "create",
    );
```

  et passer `dataDir` dans l'objet donné à `createRunExecutor({...})` de ce test ; `rm(dataDir, { recursive: true, force: true })` en fin de test. Imports à ajouter en tête : `mkdtemp, rm` de `node:fs/promises`, `tmpdir` de `node:os`, `path`, et `userSkillsRoot, writeUserSkill` depuis `./skill-store.js`. Vérifier que `spaceId`/`userId` du mock `routine.findUnique` de ce test sont bien `ws-1`/`user-1` (sinon aligner).

**Step 2: Run to verify it fails**

Run: `pnpm --filter @rakazo/adapters exec vitest run --root ../.. packages/adapters/src/executor.test.ts -t "expands @skill"`
Expected: FAIL (TS : `listAgentSkillRecords(deps.prisma, …)` n'accepte plus un `PrismaClient`).

**Step 3: Wiring**

Dans `packages/adapters/src/executor.ts`, juste après `export function createRunExecutor(deps: ExecutorDeps) {` (:563) :

```ts
  // Skills live under DATA_DIR/skills; same default as apps/api env + apps/worker.
  const skillDeps = { prisma: deps.prisma, dataDir: deps.dataDir ?? "./data" };
```

Puis remplacer le premier argument `deps.prisma` par `skillDeps` dans : `listAgentSkillRecords` (:677, :915), `skillReadFromTool` (:2287), `skillCreateFromTool`, `skillUpdateFromTool`, `skillDeleteFromTool` (:2300-2355). Rien d'autre ne change (owner + args identiques).

**Step 4: Run**

Run: `pnpm --filter @rakazo/adapters test && pnpm --filter @rakazo/adapters check && pnpm exec biome check packages/adapters/src/executor.ts packages/adapters/src/executor.test.ts packages/adapters/src/skill-tools.ts packages/adapters/src/skill-tools.test.ts`
Expected: tout vert (adapters ≈ 1140 tests).

**Step 5: Commit**

```bash
git add packages/adapters/src/executor.ts packages/adapters/src/executor.test.ts
git commit -m "feat(skills): executor loads skills from DATA_DIR

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 3 : API — service `agentSkills` sur le FS

**Files:**
- Modify: `apps/api/src/agent-skills.ts`
- Modify: `apps/api/src/router.ts:411` (`createAgentSkillsService(deps.prisma, deps.dataDir)`)
- Create: `apps/api/src/agent-skills.test.ts`

**Step 1: Write the failing test**

```ts
// apps/api/src/agent-skills.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listUserSkills, userSkillsRoot } from "@rakazo/adapters";
import { buildSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSkillsService } from "./agent-skills.js";

type Row = Record<string, unknown>;
const matches = (row: Row, where: Row) =>
  Object.entries(where).every(([key, value]) => row[key] === value);

// ponytail: same in-memory table shape as packages/adapters/src/skill-tools.test.ts.
function table(store: Row[]) {
  return {
    findMany: vi.fn(async ({ where = {} }: { where?: Row } = {}) =>
      store.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hits = store.filter((row) => matches(row, where));
      for (const row of hits) Object.assign(row, data);
      return { count: hits.length };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => {
      const kept = store.filter((row) => !matches(row, where));
      const count = store.length - kept.length;
      store.splice(0, store.length, ...kept);
      return { count };
    }),
    upsert: vi.fn(
      async ({ where, create, update }: { where: Record<string, Row>; create: Row; update: Row }) => {
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
    _store: store,
  };
}

const actor = { spaceId: "ws-1", userId: "user-1" } as never;

describe("agent skills service (filesystem)", () => {
  let dataDir: string;
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    bot: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
    skillSetting: ReturnType<typeof table>;
    botSkill: ReturnType<typeof table>;
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-api-skills-"));
    prisma = {
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
      bot: {
        findMany: vi.fn(async () => [{ id: "bot-1" }, { id: "bot-2" }]),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })),
      },
      skillSetting: table([]),
      botSkill: table([]),
    };
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const service = () => createAgentSkillsService(prisma as unknown as PrismaClient, dataDir);

  it("creates, lists, renames (cascading access rows) and removes a skill", async () => {
    const skills = service();
    const created = await skills.create(actor, {
      content: buildSkillMd({ name: "Daily Standup", description: "Notes", body: "Steps" }),
    });
    expect(created.id).toBe("user:daily standup");
    expect(created.readOnly).toBe(false);

    await skills.setAccess(actor, {
      skillId: created.id,
      availability: "selected",
      bot: { botId: "bot-1", enabled: true },
    });
    const listed = await skills.list(actor);
    expect(listed.find((s) => s.id === created.id)).toMatchObject({
      availability: "selected",
      visibleBotIds: ["bot-1"],
    });
    expect((await skills.list(actor, { botId: "bot-2" })).map((s) => s.id)).not.toContain(
      created.id,
    );

    const renamed = await skills.update(actor, { skillId: created.id, name: "Standup" });
    expect(renamed.id).toBe("user:standup");
    expect(prisma.skillSetting._store).toEqual([
      expect.objectContaining({ skillKey: "user:standup", availability: "selected" }),
    ]);
    expect(prisma.botSkill._store).toEqual([
      expect.objectContaining({ skillKey: "user:standup", botId: "bot-1", enabled: true }),
    ]);
    const files = await listUserSkills(userSkillsRoot(dataDir, actor));
    expect(files.map((f) => f.name)).toEqual(["Standup"]);

    await skills.remove(actor, renamed.id);
    expect(await listUserSkills(userSkillsRoot(dataDir, actor))).toEqual([]);
    expect(prisma.skillSetting._store).toEqual([]);
    expect(prisma.botSkill._store).toEqual([]);
  });

  it("rejects duplicate names with CONFLICT and unknown ids with IsolationError", async () => {
    const skills = service();
    await skills.create(actor, { name: "Alpha", description: "A" });
    await expect(skills.create(actor, { name: "alpha", description: "B" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(skills.get(actor, { skillId: "user:ghost" })).rejects.toMatchObject({
      name: "IsolationError",
    });
    await expect(skills.update(actor, { skillId: "builtin:x", name: "Y" })).rejects.toMatchObject({
      name: "IsolationError",
    });
  });
});
```

Vérifier le nom réel de la classe (`IsolationError` dans `@rakazo/db`) : si `error.name` n'est pas positionné, remplacer par `rejects.toBeInstanceOf(IsolationError)`.

**Step 2: Run to verify it fails**

Run: `pnpm --filter @rakazo/api exec vitest run --root ../.. apps/api/src/agent-skills.test.ts`
Expected: FAIL (`createAgentSkillsService` n'accepte qu'un argument ; `prisma.agentSkill` undefined).

**Step 3: Réécrire `apps/api/src/agent-skills.ts`**

- Imports : ajouter `listUserSkills, removeUserSkill, isExists, userSkillsRoot, writeUserSkill, type UserSkillFile` depuis `@rakazo/adapters` (à côté de `BUILTIN_AGENT_SKILLS`). Retirer `isSkillReadOnly` si plus utilisé après refonte (garder pour `builtinCatalog` si besoin — il utilise `readOnly: true` en dur, donc retirable).
- Supprimer `AgentSkillRow`, `asSource`, `mapAgentSkill`. Ajouter :

```ts
function toAgentSkill(file: UserSkillFile): AgentSkill {
  return {
    id: file.id,
    name: file.name,
    description: file.description,
    content: file.content,
    source: "user",
    readOnly: false,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  };
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
```

- `resolveSkillContent` : inchangé.
- `createAgentSkillsService(prisma: PrismaClient, dataDir: string)` :

```ts
  const root = (actor: Actor) => userSkillsRoot(dataDir, actor);
  const files = (actor: Actor) => listUserSkills(root(actor));

  async function owned(actor: Actor, skillId: string): Promise<UserSkillFile> {
    const file = (await files(actor)).find((skill) => skill.id === skillId);
    if (!file) throw new IsolationError();
    return file;
  }

  function assertNameFree(existing: UserSkillFile[], name: string, exceptId?: string) {
    const clash =
      existing.some((s) => s.id !== exceptId && sameName(s.name, name)) ||
      builtinCatalog().some((s) => sameName(s.name, name));
    if (clash) throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
  }

  function conflictOrRethrow(error: unknown): never {
    if (isExists(error)) {
      throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
    }
    throw error;
  }
```

  - `accessIndex` : inchangé.
  - `catalog` : `const [rows, access] = await Promise.all([files(actor), accessIndex(actor)]);` puis `const users = rows.map((file) => ({ ...toAgentSkill(file), ...access.of(file.name) }));`.
  - `get` : branche `skillId` → `toAgentSkill(await owned(actor, input.skillId))` ; branche `name` → builtin sinon `const file = (await files(actor)).find((s) => sameName(s.name, name)); if (!file) throw new IsolationError(); return toAgentSkill(file);`.
  - `create` :

```ts
      const resolved = resolveSkillContent(input);
      assertNameFree(await files(actor), resolved.name);
      await writeUserSkill(
        root(actor),
        { name: resolved.name, content: resolved.content },
        "create",
      ).catch(conflictOrRethrow);
      return toAgentSkill(await owned(actor, userSkillKey(resolved.name)));
```

  - `update` :

```ts
      const existing = await owned(actor, input.skillId);
      const resolved = resolveSkillContent({ ...input, prior: existing });
      const oldKey = existing.id;
      const newKey = userSkillKey(resolved.name);
      if (oldKey !== newKey) assertNameFree(await files(actor), resolved.name, existing.id);
      const scope = { spaceId: actor.spaceId, userId: actor.userId };
      if (oldKey === newKey) {
        await writeUserSkill(root(actor), { name: resolved.name, content: resolved.content }, "replace");
      } else {
        // Rename: new file first, then access rows follow the key, then the old file goes.
        await writeUserSkill(
          root(actor),
          { name: resolved.name, content: resolved.content },
          "create",
        ).catch(conflictOrRethrow);
        await prisma.$transaction([
          prisma.skillSetting.updateMany({
            where: { ...scope, skillKey: oldKey },
            data: { skillKey: newKey },
          }),
          prisma.botSkill.updateMany({
            where: { ...scope, skillKey: oldKey },
            data: { skillKey: newKey },
          }),
        ]);
        await removeUserSkill(root(actor), existing.name);
      }
      return toAgentSkill(await owned(actor, newKey));
```

  - `remove` :

```ts
      const existing = await owned(actor, skillId);
      const scope = { spaceId: actor.spaceId, userId: actor.userId };
      // File first, rows second: orphan rows are harmless, a row-less file would widen to "all".
      await removeUserSkill(root(actor), existing.name);
      await prisma.$transaction([
        prisma.skillSetting.deleteMany({ where: { ...scope, skillKey: existing.id } }),
        prisma.botSkill.deleteMany({ where: { ...scope, skillKey: existing.id } }),
      ]);
      return { ok: true };
```

  - `setAccess` : `owned` + `skillKey = existing.id` ; reste identique.
  - Les checks `isSkillReadOnly(...)` dans `update`/`remove` disparaissent (`owned` ne renvoie que des fichiers user ; un id `builtin:` lève `IsolationError` comme avant).
  - Toute gestion `P2002` disparaît.

- `apps/api/src/router.ts:411` : `const agentSkills = createAgentSkillsService(deps.prisma, deps.dataDir);`

**Step 4: Run**

Run: `pnpm --filter @rakazo/api test && pnpm --filter @rakazo/api check && pnpm exec biome check apps/api/src/agent-skills.ts apps/api/src/agent-skills.test.ts apps/api/src/router.ts`
Expected: vert (api ≈ 199 tests).

**Step 5: Commit**

```bash
git add apps/api/src/agent-skills.ts apps/api/src/agent-skills.test.ts apps/api/src/router.ts
git commit -m "feat(skills): agentSkills API serves SKILL.md files, id = skill key

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 4 : export DB→FS au boot + nettoyage à la suppression de compte

**Files:**
- Modify: `apps/api/src/agent-skills.ts` (ajouter `exportLegacyAgentSkills`)
- Modify: `apps/api/src/agent-skills.test.ts` (test export)
- Modify: `apps/api/src/app.ts` (~:125 après `const { prisma } = created;` ; hook `beforeDeleteUser` ~:254-277)

Dépend de Task 1 (et Task 3 pour le fichier de test ; si exécuté en parallèle de 3, créer le test dans un fichier séparé `apps/api/src/agent-skills-export.test.ts` et laisser l'intégration fusionner).

**Step 1: Write the failing test**

Ajouter à `apps/api/src/agent-skills.test.ts` (import `exportLegacyAgentSkills` en plus) :

```ts
describe("exportLegacyAgentSkills", () => {
  it("writes every agent_skills row to disk, deletes it, and is idempotent", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-skills-export-"));
    const rows = [
      {
        id: "row-1",
        spaceId: "ws-1",
        userId: "user-1",
        name: "Alpha",
        content: buildSkillMd({ name: "Alpha", description: "A", body: "" }),
      },
      {
        id: "row-2",
        spaceId: "ws-2",
        userId: "user-9",
        name: "Beta",
        content: buildSkillMd({ name: "Beta", description: "B", body: "" }),
      },
    ];
    const prisma = {
      agentSkill: {
        findMany: vi.fn(async () => rows.map((row) => ({ ...row }))),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
          const index = rows.findIndex((row) => row.id === where.id);
          rows.splice(index, 1);
          return {};
        }),
      },
    } as unknown as PrismaClient;

    expect(await exportLegacyAgentSkills(prisma, dataDir)).toBe(2);
    expect(rows).toEqual([]);
    expect(
      (await listUserSkills(userSkillsRoot(dataDir, { spaceId: "ws-1", userId: "user-1" }))).map(
        (s) => s.name,
      ),
    ).toEqual(["Alpha"]);
    expect(
      (await listUserSkills(userSkillsRoot(dataDir, { spaceId: "ws-2", userId: "user-9" }))).map(
        (s) => s.name,
      ),
    ).toEqual(["Beta"]);
    expect(await exportLegacyAgentSkills(prisma, dataDir)).toBe(0);
    await rm(dataDir, { recursive: true, force: true });
  });
});
```

**Step 2: Run to verify it fails**

Run: `pnpm --filter @rakazo/api exec vitest run --root ../.. apps/api/src/agent-skills.test.ts -t export`
Expected: FAIL — `exportLegacyAgentSkills` is not exported.

**Step 3: Implémenter**

Dans `apps/api/src/agent-skills.ts` :

```ts
/**
 * Skills v2 phase 2: one-shot DB→FS export of legacy `agent_skills` rows. Runs at API boot,
 * idempotent (each row is deleted once written). "replace" so a crash between write and
 * delete just rewrites the same file next boot. The table itself is dropped in phase 3:
 * `prisma migrate deploy` runs before the app boots in compose, so dropping it in the same
 * release as the export would lose the rows.
 */
export async function exportLegacyAgentSkills(
  prisma: PrismaClient,
  dataDir: string,
): Promise<number> {
  const rows = await prisma.agentSkill.findMany();
  for (const row of rows) {
    await writeUserSkill(userSkillsRoot(dataDir, row), { name: row.name, content: row.content }, "replace");
    await prisma.agentSkill.delete({ where: { id: row.id } });
  }
  return rows.length;
}
```

Dans `apps/api/src/app.ts`, après `created.pool?.on("error", () => undefined);` (~:126) :

```ts
  const exportedSkills = await exportLegacyAgentSkills(prisma, env.dataDir);
  if (exportedSkills > 0) {
    logger.info("exported legacy agent skills to disk", { count: exportedSkills });
  }
```

(import `exportLegacyAgentSkills` depuis `./agent-skills.js` ; vérifier que `logger.info(message, fields)` est bien la signature utilisée dans `apps/api/src/index.ts:18`).

Dans le hook `beforeDeleteUser`, après la ligne `await rm(pushTokenPath(env.dataDir, userId), …)` :

```ts
      await removeUserSkillDirs(env.dataDir, userId);
```

(import `removeUserSkillDirs` depuis `@rakazo/adapters`).

**Step 4: Run**

Run: `pnpm --filter @rakazo/api test && pnpm --filter @rakazo/api check && pnpm exec biome check apps/api/src/app.ts apps/api/src/agent-skills.ts apps/api/src/agent-skills.test.ts`
Expected: vert. Puis vérifier que les tests testkit qui bootent `createApp` avec un `prisma` réel passent toujours : `pnpm --filter @rakazo/testkit exec vitest run --root ../.. packages/testkit/src/attachments.test.ts` (si Docker dispo ; sinon noter « non exécuté »).

**Step 5: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/agent-skills.ts apps/api/src/agent-skills.test.ts
git commit -m "feat(skills): export legacy agent_skills rows to DATA_DIR at boot

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 5 : Web — validation live de l'éditeur SKILL.md

**Files:**
- Modify: `apps/web/src/pages/KnowledgeSection.tsx` (`AgentSkills`, ~:241-470)

Indépendante des tasks 1-4. `apps/web` dépend déjà de `@rakazo/core` (`AskCard.tsx`) ; `parseSkillMd` est pur (pas de `node:` import).

**Step 1: Implémenter**

1. Import : `import { parseSkillMd } from "@rakazo/core";`
2. Dans `AgentSkills()`, après `const editorOpen = creating || open;` (:362) :

```tsx
  const draftError = (() => {
    if (!editorOpen || open?.readOnly || !draft.trim()) return null;
    const parsed = parseSkillMd(draft);
    return "error" in parsed ? parsed.error : null;
  })();
```

3. Bouton Save : `disabled={busy || !draft.trim() || Boolean(draftError) || (!creating && draft === open?.content)}`.
4. Sous le `<textarea …/>`, avant le `<div className="mt-2 flex items-center gap-2">` :

```tsx
          {draftError ? (
            <p className="mt-1 text-[12px] text-destructive" dir="auto" role="alert">
              {draftError}
            </p>
          ) : null}
```

(vérifier que `text-destructive` existe dans le thème ; sinon reprendre la classe utilisée par `{error}` plus bas dans le même composant.) Les messages de `parseSkillMd` sont en anglais et non traduits : acceptable, ils viennent du core comme les erreurs API. `ponytail: pas de lingui sur des messages de parser`.

**Step 2: Vérifier**

Run: `pnpm --filter @rakazo/web check && pnpm --filter @rakazo/web test && pnpm exec biome check apps/web/src/pages/KnowledgeSection.tsx`
Expected: vert. Puis e2e panneau : `pnpm test:e2e -- --spec=knowledge-panel` (Docker). Expected: PASS.

**Step 3: Commit**

```bash
git add apps/web/src/pages/KnowledgeSection.tsx
git commit -m "feat(skills): live SKILL.md validation in the skills editor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 6 : passe finale — e2e, docs, vérif compose

**Files:**
- Modify: `docs/plans/2026-09-03-skills-system-design.md` (ligne phase 2 du tableau §5/§6, même style que la ligne phase 1 : `Livré : merge \`<sha>\` (2026-09-05).` + note « cache mtime non fait (YAGNI) ; drop `agent_skills` → phase 3 »)

**Step 1: Suite complète**

```bash
pnpm --filter @rakazo/core test
pnpm --filter @rakazo/adapters test
pnpm --filter @rakazo/api test
pnpm --filter @rakazo/web test
pnpm check
pnpm test:e2e -- --spec=skill-access
pnpm test:e2e -- --spec=slash-skills
pnpm test:e2e -- --spec=knowledge-panel
```

Expected: tout vert. Les specs e2e créent via `agentSkills/create` et réutilisent `created.id` (désormais `user:<name>`) pour list/setAccess/update/remove et `bots/duplicate` : aucun changement attendu.

**Step 2: Contrôles manuels ciblés**

- `grep -rn "agentSkill\." apps packages --include='*.ts' | grep -v test | grep -v generated` → seul hit attendu : `exportLegacyAgentSkills`.
- `grep -n "agent_skills\|AgentSkill" packages/db/prisma/schema.prisma` → modèle toujours présent (drop en phase 3, cf. décisions).
- Compose : `infra/compose/docker-compose.topology.yml` monte `appdata:/data` pour `api` **et** `worker` → rien à changer. Le noter dans le commit docs.

**Step 3: Docs + commit**

```bash
git add docs/plans/2026-09-03-skills-system-design.md
git commit -m "docs: record phase 2 filesystem delivery in skills v2 design

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Ne pas pousser sans demande explicite de Romain (`git push romainjeff main` uniquement).

---

## Hors périmètre phase 2 (rappel)

- Drop de la table `agent_skills` + colonne `content` : phase 3, migration SQL `DROP TABLE agent_skills` **une release après** celle qui embarque l'export.
- Cache mtime, watcher, warning UI sur fichier invalide, `skill_list`, cap catalogue > 50.
- Marketplaces, `scripts/`/`references/`, mount RO dans le sandbox, `SpaceMarketplace`.
- Édition de skills depuis le sandbox (le bot écrit via `skill_*` uniquement ; `DATA_DIR/skills` n'est pas monté).
