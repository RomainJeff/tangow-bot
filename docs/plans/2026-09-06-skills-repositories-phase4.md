# Skills v2 — Phase 4 : Skills repositories (format skills.sh) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Statut : livré c7d7adfd.**

**Goal :** ajouter une URL GitHub qui n'a **pas** de `.claude-plugin/marketplace.json` mais expose des `SKILL.md` (layout `npx skills` / skills.sh), la voir apparaître comme un **marketplace** dans la UI, parcourir ses skills, et **cocher lesquels installer** en un seul téléchargement.

**Architecture :** *manifest synthétique*. Un repo sans manifest est scanné (`skills/`, `.claude/skills/`, `.agents/skills/`, ou `SKILL.md` racine) et transformé en `MarketplaceManifest` en mémoire — un plugin par skill, `source: "./<chemin>"`. Le JSON synthétique est écrit sur disque au même endroit que le vrai manifest, donc **tout le pipeline aval phase 3 (browse, install, catalogue `mkt:`, montages sandbox, update/diff, remove, droits) ne bouge pas.** Seul ajout au store : un plugin dont le dossier *est* un skill (`SKILL.md` à sa racine) s'installe sous son propre nom. Une colonne `kind` sur `SpaceMarketplace` ne sert qu'à la UI (badge, wording). Nouveau RPC batch `installPlugins` pour installer N skills avec un seul checkout.

**Tech Stack :** TS monorepo pnpm/turbo, Prisma (migrations SQL manuelles), oRPC + zod (`@rakazo/contracts`), React + lingui, `@rakazo/ui-web` (base-ui `Checkbox`, `Badge`), vitest, Playwright, biome.

**Référence :** phase 3 livrée `afd056b9` (`docs/plans/2026-09-05-skills-marketplaces-phase3.md`) — mêmes conventions de worktree, tests, format.

---

## Décisions phase 4 (arbitrages validés par Romain)

| # | Sujet | Décision |
|---|---|---|
| Q1 | Sélection multiple dans Browse | Checkboxes par card + bouton « Install selected (N) » + RPC batch `marketplaces.installPlugins` (un seul checkout). Remove reste unitaire. |
| Q2 | Repo avec manifest **et** `SKILL.md` en vrac | Le manifest gagne (comportement phase 3 inchangé). Pas de fusion, pas de sélecteur. |
| Q3 | Nom du marketplace d'un skills repo | `<owner>-<repo>` lowercased (ex. `vercel-labs-agent-skills`). |
| Q4 | URL sous-chemin `/tree/<ref>/<path>` | Hors v1. `parseGithubRepoUrl` continue de rejeter. |
| Q5 | Visibilité du format | Badge `Plugins` / `Skills` sur la ligne marketplace + compteur « N skills installed ». |
| Q6 | Racines scannées | `SKILL.md` racine, `skills/`, `.claude/skills/`, `.agents/skills/`. Pas de `.cursor`/`.codex`/`.opencode` en v1 (constante, 1 ligne à ajouter). |
| — | Plugin disparu upstream à l'`applyUpdate` | Retiré (`removeInstalledPlugin` + `forgetSkillRows`) avec log au lieu de faire échouer l'update. Bug latent phase 3, corrigé pour les deux kinds. |
| — | Clé catalogue | `mkt:<owner>-<repo>/<slug>/<slug>` (redondance assumée, id interne). |
| — | Hors périmètre | Recherche skills.sh, sources non-GitHub, repos privés, `metadata.pluginRoot`, 2ᵉ niveau de catégorie, mobile, hint « N new skills upstream » dans checkUpdate. |

---

## Conventions d'exécution (identiques phase 3)

- **Worktree par tâche**, jamais changer la branche de `~/workspace/rakazo-bot` :
  ```bash
  cd ~/workspace/rakazo-bot && git worktree add -b feat/skills-p4-tN ../rakazo-bot-wt-p4-tN main && cd ../rakazo-bot-wt-p4-tN && pnpm install --frozen-lockfile --prefer-offline && pnpm --filter @rakazo/db exec prisma generate
  ```
- Tests ciblés : `pnpm --filter @rakazo/adapters test -- marketplace-store`, `pnpm --filter @rakazo/api test -- marketplaces`. Types : `pnpm --filter <pkg> check`. Format avant commit : `pnpm format` (biome). **Pas de `pnpm lint` racine.**
- **Jamais `git push origin`.** Push uniquement sur demande explicite, et vers `romainjeff`.
- Trailer de commit : `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Ordre : **T1 ∥ T2 → T3 → T4 ∥ T5.** T3 dépend de T1 (colonne `kind`) et T2 (store). T4 dépend de T3 (RPC `installPlugins`, DTO `kind`).
- Code et commits en anglais. Commentaires `// ponytail:` sur les simplifications volontaires.

---

## Task 1 : colonne `kind` (DB + contrat + DTO)

**Files:**
- Modify: `packages/db/prisma/schema.prisma:741-755` (model `SpaceMarketplace`)
- Create: `packages/db/prisma/migrations/20260906030000_space_marketplace_kind/migration.sql`
- Modify: `packages/contracts/src/domain.ts:465-475` (`SpaceMarketplaceSchema`)
- Modify: `apps/api/src/marketplaces.ts:79-88` (`toDto`)
- Test: `apps/api/src/marketplaces.test.ts` (assertion existante sur `add`, fixture `table`)

**Step 1 : test qui échoue — le DTO expose `kind`**

Dans `apps/api/src/marketplaces.test.ts`, test `"adds a marketplace: pins HEAD, copies the manifest, creates the row; refuses duplicates"`, étendre le `toMatchObject` :

```ts
    expect(added).toMatchObject({
      name: "acme",
      url: URL_,
      ref: "HEAD",
      commit: SHA1,
      installedPlugins: [],
      kind: "marketplace",
    });
```

**Step 2 : vérifier l'échec**

Run: `pnpm --filter @rakazo/api test -- marketplaces`
Expected: FAIL — `kind` absent du DTO.

**Step 3 : schéma Prisma**

`packages/db/prisma/schema.prisma`, après `installedPlugins` :

```prisma
  installedPlugins Json     @default("[]")
  /// "marketplace" (.claude-plugin/marketplace.json) or "skills" (skills.sh layout, synthetic manifest). UI-only.
  kind             String   @default("marketplace")
```

**Step 4 : migration SQL**

Créer `packages/db/prisma/migrations/20260906030000_space_marketplace_kind/migration.sql` :

```sql
ALTER TABLE "space_marketplaces" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'marketplace';
```

Run: `pnpm --filter @rakazo/db exec prisma validate && pnpm --filter @rakazo/db exec prisma generate`
Expected: `The schema … is valid` puis client régénéré.

**Step 5 : contrat**

`packages/contracts/src/domain.ts`, dans `SpaceMarketplaceSchema` après `installedPlugins` :

```ts
  installedPlugins: z.array(z.string()),
  /** Phase 4: how the repository is read. Drives UI wording only. */
  kind: z.enum(["marketplace", "skills"]),
```

**Step 6 : DTO**

`apps/api/src/marketplaces.ts`, `toDto` :

```ts
const toDto = (row: Row): SpaceMarketplace => ({
  id: row.id,
  name: row.name,
  url: row.url,
  ref: row.ref,
  commit: row.commit,
  installedPlugins: installedNames(row),
  kind: row.kind === "skills" ? "skills" : "marketplace",
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
```

`// ponytail:` pas d'écriture de `kind` dans `add` ici — T3 le fait ; le default Prisma couvre l'entre-deux.

**Step 7 : fixture de test — le mock Prisma ne connaît pas les defaults**

`apps/api/src/marketplaces.test.ts`, fonction `table`, méthode `create` : ajouter `kind: "marketplace"` avant `...data` :

```ts
      const row = {
        id: `mkt-${store.length + 1}`,
        kind: "marketplace",
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
```

(Adapter au nom exact des variables de la fixture existante.)

**Step 8 : vérifier le vert**

Run: `pnpm --filter @rakazo/api test -- marketplaces && pnpm --filter @rakazo/api check && pnpm --filter @rakazo/contracts check && pnpm --filter @rakazo/web check`
Expected: PASS partout. (`web` compile : aucun consommateur n'exige encore `kind`.)

**Step 9 : commit**

```bash
pnpm format && git add packages/db/prisma packages/contracts/src/domain.ts apps/api/src/marketplaces.ts apps/api/src/marketplaces.test.ts && git commit -m "Add SpaceMarketplace.kind (marketplace | skills)"
```

---

## Task 2 : store — découverte skills.sh, manifest synthétique, plugin = skill nu

**Files:**
- Modify: `packages/adapters/src/marketplace-store.ts` (`readMarketplaceManifest` :98, `scanSkillDirs` :157, `resolveSkillDirs` :171, `installPluginTree` :290, nouveaux exports)
- Test: `packages/adapters/src/marketplace-store.test.ts`

### 2.1 `resolveSkillDirs` accepte un plugin qui est lui-même un skill

**Step 1 : test qui échoue**

Ajouter dans `marketplace-store.test.ts` (imports déjà présents : `installPluginTree`, `listMarketplaceSkills`, `marketplacesRoot`, `buildSkillMd`, `tmp`) :

```ts
  it("installs a plugin whose directory is itself a skill under the plugin name", async () => {
    const dir = await tmp();
    await writeFile(
      path.join(dir, "SKILL.md"),
      buildSkillMd({ name: "TDD", description: "Red green refactor", body: "Steps" }),
    );
    const root = marketplacesRoot(await tmp(), "space1");
    await installPluginTree(root, "solo", "tdd", dir);
    expect((await listMarketplaceSkills(root)).map((s) => s.id)).toEqual(["mkt:solo/tdd/tdd"]);
  });
```

**Step 2 : vérifier l'échec**

Run: `pnpm --filter @rakazo/adapters test -- marketplace-store`
Expected: FAIL — `Plugin "tdd" has no skills/ directory.`

**Step 3 : implémentation**

`marketplace-store.ts`, `resolveSkillDirs` — nouvelle signature et early return :

```ts
/** Skill directories of a plugin, keyed by the flat slug they install as. */
async function resolveSkillDirs(
  pluginDir: string,
  pluginName: string,
): Promise<{ slug: string; dir: string }[]> {
  // A plugin that is itself a skill (skills.sh repositories, bare-skill plugins) installs as one.
  if (await stat(path.join(pluginDir, "SKILL.md")).catch(() => null)) {
    return [{ slug: pluginName, dir: pluginDir }];
  }
  // … corps existant inchangé (declaredSkillDirs ?? scanSkillDirs(path.join(pluginDir, "skills")))
```

Dans `installPluginTree` (:290) : `const skills = await resolveSkillDirs(pluginDir, pluginName);`

**Step 4 : vert**

Run: `pnpm --filter @rakazo/adapters test -- marketplace-store`
Expected: PASS (anciens tests inclus).

**Step 5 : commit**

```bash
pnpm format && git add packages/adapters/src/marketplace-store.ts packages/adapters/src/marketplace-store.test.ts && git commit -m "Install a plugin whose directory is itself a skill"
```

### 2.2 `discoverSkills` (layout skills.sh)

**Step 1 : tests qui échouent**

Ajouter à l'import de `./marketplace-store.js` : `discoverSkills`, `loadOrSynthesizeManifest`. Ajouter (helpers + describe) :

```ts
/** A skills.sh-style repository: no manifest, SKILL.md files under conventional roots. */
async function skillsRepo(files: Record<string, string>) {
  const dir = await tmp();
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  return dir;
}
const md = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: About ${name}\n${extra}---\nBody`;

describe("discoverSkills", () => {
  it("finds skills under skills/, .claude/skills/, .agents/skills/ and one category level", async () => {
    const dir = await skillsRepo({
      "skills/tdd/SKILL.md": md("TDD"),
      "skills/writing/Blog-Post/SKILL.md": md("Blog"),
      ".claude/skills/review/SKILL.md": md("Review"),
      ".agents/skills/deploy/SKILL.md": md("Deploy"),
      "README.md": "not a skill",
    });
    expect(await discoverSkills(dir, "repo")).toEqual([
      { slug: "blog-post", relPath: "./skills/writing/Blog-Post", description: "About Blog" },
      { slug: "deploy", relPath: "./.agents/skills/deploy", description: "About Deploy" },
      { slug: "review", relPath: "./.claude/skills/review", description: "About Review" },
      { slug: "tdd", relPath: "./skills/tdd", description: "About TDD" },
    ]);
  });

  it("a root SKILL.md makes the repository a single skill named after it", async () => {
    const dir = await skillsRepo({ "SKILL.md": md("Solo"), "skills/x/SKILL.md": md("X") });
    expect(await discoverSkills(dir, "my-repo")).toEqual([
      { slug: "my-repo", relPath: "./", description: "About Solo" },
    ]);
  });

  it("skips internal, invalid and unsafe skills; the first root wins on a slug clash", async () => {
    const dir = await skillsRepo({
      "skills/tdd/SKILL.md": md("TDD"),
      ".claude/skills/tdd/SKILL.md": md("Shadowed"),
      "skills/hidden/SKILL.md": md("Hidden", "metadata:\n  internal: true\n"),
      "skills/broken/SKILL.md": "no frontmatter",
      "skills/Bad Name/SKILL.md": md("Bad"),
    });
    expect((await discoverSkills(dir, "repo")).map((s) => [s.slug, s.description])).toEqual([
      ["tdd", "About TDD"],
    ]);
  });
});
```

**Step 2 : vérifier l'échec**

Run: `pnpm --filter @rakazo/adapters test -- marketplace-store`
Expected: FAIL — `discoverSkills is not a function`.

**Step 3 : implémentation**

`marketplace-store.ts`, après `scanSkillDirs` :

```ts
/** Roots `npx skills add` reads, in precedence order. */
// ponytail: .cursor/.codex/.opencode not seen in real repos yet; one line each when asked.
const SKILL_ROOTS = ["skills", ".claude/skills", ".agents/skills"];

export type DiscoveredSkill = { slug: string; relPath: string; description: string };

/** Description of the SKILL.md in `dir`; null when absent, invalid, oversized or `metadata.internal`. */
async function describeSkill(dir: string): Promise<string | null> {
  const file = path.join(dir, "SKILL.md");
  const size = (await stat(file).catch(() => null))?.size;
  if (size === undefined || size > MAX_SKILL_MD_BYTES) return null;
  const parsed = parseSkillMd(await readFile(file, "utf8"));
  if ("error" in parsed) return null;
  const meta = parsed.frontmatter.metadata;
  if (meta && typeof meta === "object" && (meta as Record<string, unknown>).internal === true) {
    return null;
  }
  return parsed.description;
}

/**
 * Skills of a repository without a marketplace manifest (skills.sh layout). A root SKILL.md
 * makes the whole repository one skill named `rootSlug`; otherwise every `<root>/<slug>/`
 * (one category level deep) that holds a valid SKILL.md. Invalid frontmatter, unsafe names
 * and `metadata.internal: true` are skipped; a slug seen under an earlier root shadows later ones.
 */
export async function discoverSkills(
  checkoutDir: string,
  rootSlug: string,
): Promise<DiscoveredSkill[]> {
  const root = await describeSkill(checkoutDir);
  if (root !== null) return [{ slug: rootSlug, relPath: "./", description: root }];
  const found = new Map<string, DiscoveredSkill>();
  for (const skillsRoot of SKILL_ROOTS) {
    for (const dir of await scanSkillDirs(path.join(checkoutDir, skillsRoot))) {
      const slug = path.basename(dir).toLowerCase();
      if (!SAFE_NAME.test(slug) || found.has(slug)) continue;
      const description = await describeSkill(dir);
      if (description === null) continue;
      found.set(slug, { slug, relPath: `./${path.relative(checkoutDir, dir)}`, description });
    }
  }
  return [...found.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}
```

Vérifier que `scanSkillDirs` tolère un dossier absent (renvoie `[]`) — sinon ajouter `.catch(() => [])` sur son `readdir`. `path.relative` renvoie des `/` sur POSIX ; `parsePluginSource` refuse `..` — containment conservée.

**Step 4 : vert**

Run: `pnpm --filter @rakazo/adapters test -- marketplace-store`
Expected: PASS pour les 3 tests `discoverSkills`.

**Step 5 : commit**

```bash
pnpm format && git add packages/adapters/src/marketplace-store.ts packages/adapters/src/marketplace-store.test.ts && git commit -m "Discover skills.sh-style skills in a repository checkout"
```

### 2.3 `loadOrSynthesizeManifest`

**Step 1 : tests qui échouent**

```ts
describe("loadOrSynthesizeManifest", () => {
  const repo = { owner: "Vercel-Labs", repo: "Agent-Skills" };

  it("returns the real manifest when present, even if loose SKILL.md files exist", async () => {
    const dir = await checkout();
    await mkdir(path.join(dir, "skills/loose"), { recursive: true });
    await writeFile(path.join(dir, "skills/loose/SKILL.md"), md("Loose"));
    const loaded = await loadOrSynthesizeManifest(dir, repo);
    expect(loaded.kind).toBe("marketplace");
    expect(loaded.manifest.name).toBe("acme");
    expect(loaded.raw).toBe(
      await readFile(path.join(dir, ".claude-plugin/marketplace.json"), "utf8"),
    );
  });

  it("synthesizes one plugin per discovered skill, named <owner>-<repo>", async () => {
    const dir = await skillsRepo({ "skills/tdd/SKILL.md": md("TDD"), "skills/b/SKILL.md": md("B") });
    const loaded = await loadOrSynthesizeManifest(dir, repo);
    expect(loaded.kind).toBe("skills");
    expect(loaded.manifest.name).toBe("vercel-labs-agent-skills");
    expect(loaded.manifest.plugins).toEqual([
      { name: "b", source: { kind: "local", path: "./skills/b" }, description: "About B", supported: true },
      { name: "tdd", source: { kind: "local", path: "./skills/tdd" }, description: "About TDD", supported: true },
    ]);
    // The raw JSON round-trips through the real reader: what add() writes is what plugins() reads.
    await mkdir(path.join(dir, ".claude-plugin"));
    await writeFile(path.join(dir, ".claude-plugin/marketplace.json"), loaded.raw);
    expect(await readMarketplaceManifest(dir)).toEqual(loaded.manifest);
  });

  it("rejects a repository with neither manifest nor skills", async () => {
    const dir = await skillsRepo({ "README.md": "nothing" });
    await expect(loadOrSynthesizeManifest(dir, repo)).rejects.toThrow(
      "Repository has neither .claude-plugin/marketplace.json nor any SKILL.md.",
    );
  });
});
```

(Adapter la forme attendue de `source` à la vraie shape de `PluginSource` local — lire `parsePluginSource` :74.)

**Step 2 : vérifier l'échec**

Run: `pnpm --filter @rakazo/adapters test -- marketplace-store`
Expected: FAIL — `loadOrSynthesizeManifest is not a function`.

**Step 3 : implémentation — extraire `parseManifest`, ajouter le loader**

Remplacer `readMarketplaceManifest` (:98-125) par :

```ts
const MANIFEST_PATH = path.join(".claude-plugin", "marketplace.json");

/**
 * Reads `.claude-plugin/marketplace.json` from an extracted checkout. Plugins whose source is
 * neither a `./` path nor a public GitHub repository are listed but flagged unsupported.
 */
export async function readMarketplaceManifest(checkoutDir: string): Promise<MarketplaceManifest> {
  const raw = await readFile(path.join(checkoutDir, MANIFEST_PATH), "utf8").catch(() => {
    throw new Error("Repository has no .claude-plugin/marketplace.json.");
  });
  return parseManifest(raw);
}

function parseManifest(raw: string): MarketplaceManifest {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("marketplace.json is invalid JSON.");
  }
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("marketplace.json is invalid: expected { name, plugins: [{ name, source }] }.");
  }
  // … mapping existant (safeName, parsePluginSource, supported) inchangé
}

export type MarketplaceKind = "marketplace" | "skills";
export type LoadedManifest = {
  manifest: MarketplaceManifest;
  kind: MarketplaceKind;
  /** File content to persist as the marketplace's manifest (real or synthesized). */
  raw: string;
};

/**
 * Phase 4: the real manifest when the repository ships one (it always wins), otherwise a
 * manifest synthesized from its SKILL.md files — one single-skill plugin per skill, named
 * `<owner>-<repo>`. The synthetic JSON goes through the same parser, so what gets written to
 * disk is exactly what `readMarketplaceManifest` reads back later.
 */
export async function loadOrSynthesizeManifest(
  checkoutDir: string,
  repo: GithubRepo,
): Promise<LoadedManifest> {
  const real = await readFile(path.join(checkoutDir, MANIFEST_PATH), "utf8").catch(() => null);
  if (real !== null) return { manifest: parseManifest(real), kind: "marketplace", raw: real };
  const skills = await discoverSkills(checkoutDir, repo.repo.toLowerCase());
  if (skills.length === 0) {
    throw new Error("Repository has neither .claude-plugin/marketplace.json nor any SKILL.md.");
  }
  const raw = JSON.stringify(
    {
      name: `${repo.owner}-${repo.repo}`,
      plugins: skills.map((s) => ({ name: s.slug, source: s.relPath, description: s.description })),
    },
    null,
    2,
  );
  return { manifest: parseManifest(raw), kind: "skills", raw };
}
```

Import : `import { type GithubRepo, parseGithubRepoUrl } from "./github-tarball.js";`. `safeName` lowercase + `SAFE_NAME` (≤ 64 chars) : un `<owner>-<repo>` hors gabarit remonte l'erreur utilisateur existante, acceptable.

**Step 4 : vert + types**

Run: `pnpm --filter @rakazo/adapters test -- marketplace-store && pnpm --filter @rakazo/adapters check`
Expected: PASS.

**Step 5 : commit**

```bash
pnpm format && git add packages/adapters/src/marketplace-store.ts packages/adapters/src/marketplace-store.test.ts && git commit -m "Synthesize a marketplace manifest for skills.sh repositories"
```

---

## Task 3 : service — checkout auto-détecté, `kind`, `applyUpdate` tolérant, RPC batch `installPlugins`

Dépend de T1 et T2 mergés dans `main` (worktree T3 créé après).

**Files:**
- Modify: `apps/api/src/marketplaces.ts` (imports :6-32, `checkout` :118, `add` :189, `installPlugin` :226, `applyUpdate` :288)
- Modify: `packages/contracts/src/rpc.ts:499-519`
- Modify: `apps/api/src/router.ts:2364-2389`
- Test: `apps/api/src/marketplaces.test.ts`

### 3.1 `checkout()` détecte le format ; `add()` écrit le manifest synthétique + `kind`

**Step 1 : tests qui échouent**

Dans `marketplaces.test.ts`, après les constantes `v1`/`v2` :

```ts
const SKILLS_URL = "https://github.com/vercel-labs/agent-skills";
const SK1 = "3".repeat(40);
const SK2 = "4".repeat(40);
/** skills.sh layout: no manifest. `.claude/skills/tdd` is shadowed by `skills/tdd`. */
const skillsV1: Tree = {
  "skills/tdd/SKILL.md": skill("tdd", "red green"),
  "skills/review/SKILL.md": skill("review", "look twice"),
  ".claude/skills/tdd/SKILL.md": skill("tdd", "shadowed"),
  "README.md": "docs",
};
/** `review` vanished upstream. */
const skillsV2: Tree = { "skills/tdd/SKILL.md": skill("tdd", "red green refactor") };
```

Dans `beforeEach` : `repos.set(SK1, skillsV1); repos.set(SK2, skillsV2);` (le mock `downloadGithubTarball` résout `repos.get(sha)`).

Nouveau bloc :

```ts
  describe("skills repositories (phase 4)", () => {
    it("adds a repository without a manifest as a `skills` marketplace named <owner>-<repo>", async () => {
      headSha = SK1;
      const m = service();
      const added = await m.add(actor, { url: SKILLS_URL });
      expect(added).toMatchObject({ name: "vercel-labs-agent-skills", kind: "skills", commit: SK1 });
      expect(prisma.spaceMarketplace._store[0]?.kind).toBe("skills");
      const written = JSON.parse(
        await readFile(
          path.join(root(), "vercel-labs-agent-skills/.claude-plugin/marketplace.json"),
          "utf8",
        ),
      );
      expect(written.plugins).toEqual([
        { name: "review", source: "./skills/review", description: "d" },
        { name: "tdd", source: "./skills/tdd", description: "d" },
      ]);
      expect(await m.plugins(actor, added.id)).toEqual([
        { name: "review", description: "d", supported: true, installed: false },
        { name: "tdd", description: "d", supported: true, installed: false },
      ]);
    });

    it("refuses a repository with neither manifest nor SKILL.md", async () => {
      headSha = SK1;
      repos.set(SK1, { "README.md": "nothing" });
      await expect(service().add(actor, { url: SKILLS_URL })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Repository has neither .claude-plugin/marketplace.json nor any SKILL.md.",
      });
    });
  });
```

**Step 2 : vérifier l'échec**

Run: `pnpm --filter @rakazo/api test -- marketplaces`
Expected: FAIL — `Repository has no .claude-plugin/marketplace.json.`

**Step 3 : implémentation**

Imports `@rakazo/adapters` : garder `readMarketplaceManifest` (utilisé par `plugins()`), ajouter `loadOrSynthesizeManifest`, `type MarketplaceKind`. Ajouter `import { getLogger } from "@rakazo/logging";` (utilisé en 3.2).

`checkout` :

```ts
  async function checkout(
    url: string,
    ref: string,
    commit?: string,
  ): Promise<{
    dir: string;
    commit: string;
    manifest: MarketplaceManifest;
    kind: MarketplaceKind;
    raw: string;
  }> {
    const { dir, commit: sha } = await download(url, ref, commit);
    try {
      return { dir, commit: sha, ...(await loadOrSynthesizeManifest(dir, parseGithubRepoUrl(url))) };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      badRequest(error);
    }
  }
```

`add` : destructurer `{ dir, commit, manifest, kind, raw }` ; remplacer la copie `readFile(path.join(dir, MANIFEST))` par `writeFile(path.join(target, MANIFEST), raw)` ; `create({ data: { spaceId, name: manifest.name, url, ref, commit, kind } })`. Retirer `readFile` de l'import `node:fs/promises` s'il n'a plus d'usage.

**Step 4 : vert**

Run: `pnpm --filter @rakazo/api test -- marketplaces && pnpm --filter @rakazo/api check`
Expected: PASS.

**Step 5 : commit**

```bash
pnpm format && git add apps/api/src/marketplaces.ts apps/api/src/marketplaces.test.ts && git commit -m "Add skills.sh repositories as marketplaces"
```

### 3.2 RPC batch `installPlugins`

**Step 1 : tests qui échouent**

Dans `describe("skills repositories (phase 4)")` :

```ts
    it("installPlugins installs several skills from one checkout and keeps earlier installs", async () => {
      headSha = SK1;
      const m = service();
      const { id } = await m.add(actor, { url: SKILLS_URL });
      await m.installPlugin(actor, id, "tdd");
      const row = await m.installPlugins(actor, id, ["review", "tdd"]);
      expect(row.installedPlugins).toEqual(["review", "tdd"]);
      expect((await listMarketplaceSkills(root())).map((s) => s.id)).toEqual([
        "mkt:vercel-labs-agent-skills/review/review",
        "mkt:vercel-labs-agent-skills/tdd/tdd",
      ]);
      expect(
        await readFile(
          path.join(root(), "vercel-labs-agent-skills/plugins/tdd/skills/tdd/SKILL.md"),
          "utf8",
        ),
      ).toBe(skill("tdd", "red green"));
    });

    it("installPlugins persists the plugins that succeeded before a failing one", async () => {
      headSha = SK1;
      const m = service();
      const { id } = await m.add(actor, { url: SKILLS_URL });
      await expect(m.installPlugins(actor, id, ["tdd", "nope"])).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(prisma.spaceMarketplace._store[0]?.installedPlugins).toEqual([{ name: "tdd" }]);
    });
```

(`listMarketplaceSkills` : le `vi.mock("@rakazo/adapters")` utilise `importOriginal` pour le reste — vérifier qu'il est bien passthrough, sinon l'importer depuis l'original.)

**Step 2 : vérifier l'échec**

Run: `pnpm --filter @rakazo/api test -- marketplaces`
Expected: FAIL — `m.installPlugins is not a function`.

**Step 3 : contrat**

`packages/contracts/src/rpc.ts`, après `installPlugin` :

```ts
    /** Phase 4: several plugins from one checkout (Browse "Install selected"). */
    installPlugins: oc
      .input(
        z.object({
          marketplaceId: Id,
          plugins: z.array(z.string().min(1).max(64)).min(1).max(100),
        }),
      )
      .output(SpaceMarketplaceSchema),
```

**Step 4 : service**

Dans `createMarketplacesService`, avant `return {` :

```ts
  /** Installs `plugins` from one checkout. Whatever installed before a failure is persisted. */
  async function installPlugins(
    actor: Actor,
    marketplaceId: string,
    plugins: string[],
  ): Promise<SpaceMarketplace> {
    const row = await owned(actor, marketplaceId);
    const { dir, manifest } = await checkout(row.url, row.ref, row.commit);
    const added: Installed[] = [];
    const merged = () => {
      const names = new Set(added.map((p) => p.name));
      return [...installedPlugins(row).filter((p) => !names.has(p.name)), ...added].sort(byName);
    };
    try {
      for (const plugin of plugins) {
        added.push(entry(plugin, await installOne(root(actor), row, dir, manifest, plugin)));
      }
    } catch (error) {
      await setInstalled(row, merged());
      badRequest(error);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return setInstalled(row, merged());
  }
```

Dans l'objet retourné, remplacer la méthode `installPlugin` existante par :

```ts
    installPlugins,
    installPlugin: (actor: Actor, marketplaceId: string, plugin: string) =>
      installPlugins(actor, marketplaceId, [plugin]),
```

(Adapter `root(actor)` / `installOne` aux signatures réelles :137/:159.)

**Step 5 : router**

`apps/api/src/router.ts`, après le handler `installPlugin` :

```ts
      installPlugins: authed.marketplaces.installPlugins.handler(async ({ context, input }) =>
        marketplaces.installPlugins(context.actor, input.marketplaceId, input.plugins),
      ),
```

**Step 6 : vert + types**

Run: `pnpm --filter @rakazo/api test -- marketplaces && pnpm --filter @rakazo/contracts check && pnpm --filter @rakazo/api check`
Expected: PASS. Tests phase 3 sur `installPlugin`/`removePlugin` toujours verts (même comportement : checkout unique, merge, tri).

**Step 7 : commit**

```bash
pnpm format && git add packages/contracts/src/rpc.ts apps/api/src/router.ts apps/api/src/marketplaces.ts apps/api/src/marketplaces.test.ts && git commit -m "Add marketplaces.installPlugins batch RPC"
```

### 3.3 `applyUpdate` retire un plugin disparu upstream

**Step 1 : test qui échoue**

```ts
    it("applyUpdate drops a plugin that vanished upstream instead of failing", async () => {
      headSha = SK1;
      const m = service();
      const { id } = await m.add(actor, { url: SKILLS_URL });
      await m.installPlugins(actor, id, ["tdd", "review"]);
      prisma.skillSetting._store.push({
        spaceId: "ws-1",
        skillKey: "mkt:vercel-labs-agent-skills/review/review",
      });
      headSha = SK2;
      const check = await m.checkUpdate(actor, id);
      expect(check.upToDate).toBe(false);
      expect(check.changes.map((c) => [c.path, c.status])).toEqual([
        ["review/review/SKILL.md", "removed"],
        ["tdd/tdd/SKILL.md", "modified"],
      ]);
      const row = await m.applyUpdate(actor, id, SK2);
      expect(row.installedPlugins).toEqual(["tdd"]);
      expect(await exists(path.join(root(), "vercel-labs-agent-skills/plugins/review"))).toBe(false);
      expect(prisma.skillSetting._store).toEqual([]);
      expect((await m.plugins(actor, id)).map((p) => p.name)).toEqual(["tdd"]);
    });
```

(Adapter `check.changes` à la shape réelle de `FileChange` et au format de `path` produit par `diffPluginTrees` — lire :338 et le test phase 3 existant sur `checkUpdate`.)

**Step 2 : vérifier l'échec**

Run: `pnpm --filter @rakazo/api test -- marketplaces`
Expected: FAIL — `applyUpdate` lève BAD_REQUEST (plugin `review` introuvable dans le manifest).

**Step 3 : implémentation**

`applyUpdate` :

```ts
    async applyUpdate(actor: Actor, marketplaceId: string, commit: string): Promise<SpaceMarketplace> {
      const row = await owned(actor, marketplaceId);
      const { dir, manifest, raw } = await checkout(row.url, row.ref, commit);
      const pinned: Installed[] = [];
      try {
        await writeFile(path.join(root(actor), row.name, MANIFEST), raw);
        for (const { name } of installedPlugins(row)) {
          if (!manifest.plugins.some((p) => p.name === name)) {
            // Gone upstream: drop it rather than fail the whole update.
            getLogger().info(`[skills] ${row.name}/${name}: no longer upstream, removed`);
            await removeInstalledPlugin(root(actor), row.name, name);
            await forgetSkillRows(actor, `mkt:${row.name}/${name}/`);
            continue;
          }
          pinned.push(entry(name, await installOne(root(actor), row, dir, manifest, name)));
        }
      } catch (error) {
        badRequest(error);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return toDto(
        await prisma.spaceMarketplace.update({
          where: { id: row.id },
          data: { commit, installedPlugins: pinned.sort(byName) },
        }),
      );
    },
```

(Adapter au chemin exact du manifest utilisé par l'`applyUpdate` actuel :288 et à la signature de `removeInstalledPlugin` :319.)

**Step 4 : vert**

Run: `pnpm --filter @rakazo/api test -- marketplaces && pnpm --filter @rakazo/api check`
Expected: PASS.

**Step 5 : commit**

```bash
pnpm format && git add apps/api/src/marketplaces.ts apps/api/src/marketplaces.test.ts && git commit -m "applyUpdate drops plugins that vanished upstream"
```

---

## Task 4 : UI `SkillsOverlay`

Dépend de T3 mergé (`kind` dans le DTO, `rpc.marketplaces.installPlugins`).

**Files:**
- Modify: `apps/web/src/pages/SkillsOverlay.tsx` (imports :10-24, `MarketplacesTab` :164-330, `BrowseTab` :367-520)
- Modify: `apps/web/e2e/skills-overlay.spec.ts:42-48`
- Generated: `apps/web/src/locales/*/messages.po` (lingui extract)

Pas de test unitaire React dans `apps/web/src/pages` : vérification = `check` + e2e + screenshot.

### 4.1 Onglet Marketplaces : texte d'aide, badge, compteur

**Step 1 : e2e qui échoue**

`apps/web/e2e/skills-overlay.spec.ts`, après `await expect(overlay.getByText("No marketplaces added yet.")).toBeVisible();` :

```ts
  await expect(overlay.getByText(/repository of skills/)).toBeVisible();
```

Run: la commande e2e utilisée en phase 3 (`pnpm --filter @rakazo/web test:e2e -- skills-overlay` ou équivalent, voir `apps/web/package.json`).
Expected: FAIL — texte absent.

**Step 2 : implémentation**

Import : ajouter `Checkbox` à la liste `@rakazo/ui-web`.

`MarketplacesTab`, juste après `</form>` :

```tsx
      <p className="-mt-3 text-[13px] text-muted-foreground/80">
        <Trans>
          A plugin marketplace (.claude-plugin/marketplace.json) or a repository of skills
          (SKILL.md files). The format is detected automatically.
        </Trans>
      </p>
```

Ligne marketplace — nom + badge, compteur selon `kind` :

```tsx
                <div className="flex items-center gap-2 text-[15px] font-medium text-foreground">
                  {mkt.name}
                  <Badge variant="outline">
                    {mkt.kind === "skills" ? <Trans>Skills</Trans> : <Trans>Plugins</Trans>}
                  </Badge>
                </div>
                <div className="truncate text-[13px] text-muted-foreground/80">
                  {mkt.url} · {mkt.ref} @ {mkt.commit.slice(0, 7)} ·{" "}
                  {mkt.kind === "skills" ? (
                    <Trans>{mkt.installedPlugins.length} skills installed</Trans>
                  ) : (
                    <Trans>{mkt.installedPlugins.length} plugins installed</Trans>
                  )}
                </div>
```

**Step 3 : vert**

Run: `pnpm --filter @rakazo/web check` puis e2e.
Expected: PASS.

### 4.2 Onglet Browse : checkboxes + « Install selected (N) », pas de sous-liste pour `kind === "skills"`

E2e ne peut pas atteindre Browse sans réseau GitHub (règle phase 3) : vérification navigateur manuelle + screenshot.

**Step 1 : état + rechargement**

Dans `BrowseTab` :

```tsx
  const [picked, setPicked] = useState<Set<string>>(new Set());
```

`loadPlugins` : `setPicked(new Set());` en tête.

**Step 2 : action batch**, à côté de `toggle` :

```tsx
  async function installPicked() {
    if (!marketplace || picked.size === 0) return;
    setPending("batch");
    onError(null);
    try {
      await rpc.marketplaces.installPlugins({ marketplaceId: marketplace.id, plugins: [...picked] });
      await Promise.all([onChanged(), loadPlugins()]);
    } catch (err) {
      onError(errorMessage(err, t`Could not install skills`));
    } finally {
      setPending(null);
    }
  }
```

(Adapter aux noms réels de `pending`/`onError`/`onChanged` dans `BrowseTab` et au pattern `run()` s'il est réutilisable.)

**Step 3 : barre sticky**, juste après le `<NativeSelect>` :

```tsx
      {picked.size > 0 ? (
        <div className="sticky top-0 z-10 flex items-center justify-between rounded-xl border border-border bg-card px-4 py-2">
          <span className="text-[13px] text-muted-foreground">
            <Trans>{picked.size} selected</Trans>
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="rounded-full"
            disabled={pending !== null}
            onClick={() => void installPicked()}
          >
            {pending === "batch" ? (
              <Trans>Installing…</Trans>
            ) : (
              <Trans>Install selected ({picked.size})</Trans>
            )}
          </Button>
        </div>
      ) : null}
```

**Step 4 : checkbox par card**, avant `<div className="min-w-0 flex-1">` :

```tsx
              {!plugin.installed && plugin.supported ? (
                <Checkbox
                  aria-label={t`Select ${plugin.name}`}
                  checked={picked.has(plugin.name)}
                  onCheckedChange={(checked) =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(plugin.name);
                      else next.delete(plugin.name);
                      return next;
                    })
                  }
                />
              ) : null}
```

Bouton Install/Remove unitaire conservé. `// ponytail:` deux chemins d'install côté UI, un seul côté serveur.

**Step 5 : sous-liste + wording vide**

Sous-liste des skills d'un plugin installé : masquée pour `marketplace?.kind === "skills"` (1 plugin = 1 skill, redondant) ; le rappel « Off for every agent until you pick some in Installed. » reste.

Liste vide :

```tsx
          {marketplace?.kind === "skills" ? (
            <Trans>No skills in this marketplace.</Trans>
          ) : (
            <Trans>No plugins in this marketplace.</Trans>
          )}
```

**Step 6 : i18n**

```bash
pnpm --filter @rakazo/web intl:extract && pnpm --filter @rakazo/web intl:compile
```

Expected: nouveaux `msgid` dans les 8 `messages.po`. Suivre ce que phase 3 a fait pour les `msgstr` (`git show afd056b9 --stat -- apps/web/src/locales`). `.mjs` compilés gitignorés.

**Step 7 : vérification navigateur**

Dev server via `.claude/launch.json` (preview). Skills → Marketplaces : texte d'aide visible. Si réseau : ajouter `https://github.com/vercel-labs/agent-skills` → badge `Skills`, Browse liste skills + checkboxes, « Install selected (2) » = un seul appel `marketplaces/installPlugins` (`read_network_requests`), Installed montre `mkt:vercel-labs-agent-skills/<slug>/<slug>`. Screenshot.

**Step 8 : vert + commit**

Run: `pnpm --filter @rakazo/web check && pnpm format` puis e2e `skills-overlay`.
Expected: PASS.

```bash
git add apps/web/src/pages/SkillsOverlay.tsx apps/web/e2e/skills-overlay.spec.ts apps/web/src/locales && git commit -m "Skills overlay: skills repositories badge, help text, multi-select install"
```

---

## Task 5 : docs

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)
- Modify: `docs/plans/2026-09-06-skills-repositories-phase4.md` (statut)

**Step 1 : CHANGELOG**

Sous `### Added`, en tête :

```markdown
- Skills marketplaces accept repositories of skills in the `npx skills` / skills.sh layout (`skills/`, `.claude/skills/`, `.agents/skills/`, or a root `SKILL.md`) alongside `.claude-plugin/marketplace.json` marketplaces; pick several skills and install them at once from Browse. Applying a marketplace update now drops plugins that vanished upstream instead of failing.
```

**Step 2 : statut du plan**

Remplacer la ligne `**Statut : …**` de ce fichier par `**Statut : livré <sha merge>.**` une fois T4 mergé.

**Step 3 : commit**

```bash
git add CHANGELOG.md docs/plans/2026-09-06-skills-repositories-phase4.md && git commit -m "Docs: skills repositories (phase 4)"
```

---

## Vérification finale (après merge de T1–T5 dans `main`)

```bash
pnpm --filter @rakazo/db exec prisma validate && pnpm check && pnpm test && pnpm format
```

Expected: tout vert, `git status` propre après `format`.

Checklist fonctionnelle :
- [ ] Repo avec manifest → `kind: marketplace`, comportement phase 3 identique (tests phase 3 verts).
- [ ] Repo skills.sh → `kind: skills`, nom `<owner>-<repo>`, manifest synthétique sur disque.
- [ ] Repo sans rien → `Repository has neither .claude-plugin/marketplace.json nor any SKILL.md.`
- [ ] Browse : checkboxes, « Install selected (N) », un seul appel réseau.
- [ ] Installed : clés `mkt:<owner>-<repo>/<slug>/<slug>`, read-only, montées RO dans la sandbox (aucun changement supervisor).
- [ ] Check update détecte un `SKILL.md` modifié ; Apply retire un skill disparu sans échouer.
- [ ] Remove marketplace purge dossier + rows.
