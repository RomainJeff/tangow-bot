# Skills v2 — Phase 3 : Marketplaces, SkillsOverlay, montages RO

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Installer des skills depuis des marketplaces GitHub publiques (format `.claude-plugin/marketplace.json`), les exposer au catalogue et aux bots comme skills `plugin` read-only, les monter en lecture seule dans les sandboxes Docker, et regrouper tout ça dans un panneau web « Skills ».

**Architecture:** Les marketplaces sont des enregistrements Space-level (`SpaceMarketplace` en DB : url, ref, commit épinglé, plugins installés). Le contenu vit sur le FS sous `DATA_DIR/skills/marketplaces/<spaceId>/<marketplace>/` (manifest + `plugins/<plugin>/skills/<slug>/`). Le catalogue (`agentSkills.*`, `listAgentSkillRecords`) fusionne builtins + skills user + skills marketplace ; la clé publique d'un skill marketplace est `mkt:<marketplace>/<plugin>/<slug>`. Un nouveau namespace RPC `marketplaces.*` gère add / browse / install / update (diff avant apply) / remove. Le supervisor Docker monte `skills/user/<spaceId>/<userId>` et `skills/marketplaces/<spaceId>` en `:ro` dans le conteneur.

**Tech Stack:** TypeScript, pnpm monorepo, Prisma (migrations SQL manuelles), oRPC contracts (`@rakazo/contracts`), zod, `tar@^7` (déjà dans le lockfile, à ajouter en dépendance directe de `@rakazo/adapters`), `createSafeRemoteFetch` (undici, anti-SSRF), React + lingui + `@rakazo/ui-web`, vitest, Playwright.

Design de référence : `docs/plans/2026-09-03-skills-system-design.md` (§3, §4, §5 ligne 3, §6 Q3–Q11). Phases 1 et 2 livrées (`bfd29a43`).

---

## Décisions phase 3

Défauts du design (§6) retenus tels quels, plus quelques décisions d'implémentation :

| Sujet | Décision |
|---|---|
| Q1 marketplaces | Space-level : table `SpaceMarketplace` `@@unique([spaceId, name])`. Tout membre du space peut add/install/remove. |
| Q3 lock file | **Pas de `skills-lock.json`** : la ligne DB (`url`, `ref`, `commit`, `installedPlugins`) est le lock. YAGNI. |
| Q4 update | `checkUpdate` télécharge le tarball au `ref`, calcule le diff complet (SKILL.md + `scripts/` + `references/`, fichiers ajoutés/supprimés/modifiés avec tailles, contenu texte avant/après) et retourne le nouveau `commit`. `applyUpdate({ commit })` re-télécharge et remplace. Deux téléchargements acceptés (`// ponytail:`). |
| Q5 contenu consommé | Seul `<plugin>/skills/**` est copié. `commands/`, `agents/`, `hooks/`, `.mcp.json` ignorés + loggés (`getLogger`). |
| Q6 sources | GitHub public uniquement : tarball `https://codeload.github.com/<owner>/<repo>/tar.gz/<commit>` via `createSafeRemoteFetch`. Sha résolu par `GET https://api.github.com/repos/<o>/<r>/commits/<ref>` avec `Accept: application/vnd.github.sha`. `ref` par défaut `HEAD`. Plugins dont `source` n'est pas un chemin relatif (`./…`) → listés « non supporté », non installables. |
| Q7 sécurité tarball | Cap 50 MB (compteur d'octets sur le flux), extraction sans symlinks/hardlinks, tar refuse `..` et chemins absolus (`preservePaths: false`), `strip: 1`. Noms marketplace/plugin/skill validés `^[a-z0-9][a-z0-9._-]{0,63}$` (lowercase forcé). SKILL.md > 100k → tout le plugin refusé. |
| Q8 catalogue | Cap 50 conservé (`formatSkillsCatalogInstruction`). Skills marketplace `source: "plugin"`, `readOnly: true`, **availability par défaut `selected`** (visible à aucun bot tant que l'utilisateur ne l'active pas). |
| Q9 RPC | `agentSkills.*` conservé et étendu (`list/get/setAccess` couvrent les skills `mkt:`). Nouveau namespace `marketplaces.*`. `skills.*` déjà pris (TaughtSkill). |
| Q10 montages | Supervisor calcule les binds côté serveur depuis `{ spaceId, userId }` + `dataDir` (jamais de chemin client). Conteneur existant **recréé** si ses `Binds` ne contiennent pas les deux montages skills. Worker/adapter `mkdir -p` les deux dossiers avant `provision` pour éviter des dossiers créés root par Docker. |
| Q11 legacy | `DROP TABLE agent_skills`, suppression de `apps/api/src/agent-skills-export.ts` (+ test + appel dans `app.ts`), du modèle Prisma `AgentSkill`, de `skills-lock.json` et de `.agents/skills/composio/`. |
| UI | Panneau `SkillsOverlay` (web only), bouton sidebar « Skills ». Onglets **Installed / Marketplaces / Browse** ; « New skill » n'est pas un onglet séparé : l'onglet Installed embarque le composant `AgentSkills` existant (création/édition incluses). `// ponytail:` un onglet de plus pour un bouton déjà présent. `KnowledgeSection` et mobile inchangés. |
| Diff UI | Liste des fichiers (statut, tailles) + pour les fichiers texte modifiés, avant/après côte à côte dans deux `<pre>`. Pas de lib de diff (`// ponytail: side-by-side, ajouter jsdiff si illisible`). |

## Hors périmètre

TaughtSkill, marketplaces privées/tokens, sources non-GitHub (git URL, chemins locaux, npm), plugins à `source` distante, hooks/commands/agents/MCP des plugins, mobile, e2e réseau contre GitHub (couvert par tests unitaires avec `fetch` factice), droits admin-only sur les marketplaces.

## Conventions

- Prose des commentaires/commits en anglais. `// ponytail:` sur chaque simplification volontaire.
- Pas de `console.*` dans `packages/adapters` → `getLogger()`.
- Tests : `pnpm --filter <pkg> test -- <fichier>` ; types : `pnpm --filter <pkg> check` ; format : `pnpm exec biome check --write <paths>`. Ne pas lancer `pnpm lint` racine (5 échecs préexistants).
- Worktree : `git worktree add -b <branch> ../rakazo-bot-wt-NN main && cd ../rakazo-bot-wt-NN && pnpm install --frozen-lockfile --prefer-offline && pnpm --filter @rakazo/db exec prisma generate`. **Ne jamais changer la branche du checkout principal `~/workspace/rakazo-bot`.**
- Ne jamais `git push origin` (elie222/rakazo). Push uniquement `romainjeff main`, sur demande.
- Trailer commit : `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1 : Nettoyage legacy + table `SpaceMarketplace`

**Files:**
- Delete: `skills-lock.json`, `.agents/skills/composio/` (récursif), `apps/api/src/agent-skills-export.ts`, `apps/api/src/agent-skills-export.test.ts`
- Modify: `apps/api/src/app.ts:129-132` (supprimer l'appel `exportLegacyAgentSkills` + import)
- Modify: `packages/db/prisma/schema.prisma` (supprimer `model AgentSkill` lignes ~702-718 et toute relation `agentSkills` sur `Space`/`User` ; ajouter `SpaceMarketplace` + relation `marketplaces` sur `Space`)
- Create: `packages/db/prisma/migrations/20260905150000_space_marketplaces_drop_agent_skills/migration.sql`

**Step 1 : Vérifier les références**

```bash
grep -rn "agentSkill\b\|AgentSkill\b\|agent_skills\|exportLegacyAgentSkills\|skills-lock" --include=*.ts --include=*.prisma --include=*.md apps packages infra docs | grep -v "AgentSkillSchema\|AgentSkillCatalog\|AgentSkillSource\|agentSkills\.\|listAgentSkill\|createAgentSkillsService\|docs/plans/2026-09-03"
```

Attendu : uniquement `app.ts`, `agent-skills-export*.ts`, `schema.prisma`, migrations existantes. Toute autre occurrence est à traiter dans cette tâche.

**Step 2 : Supprimer les orphelins et l'export**

```bash
git rm -q skills-lock.json && git rm -rq .agents/skills/composio apps/api/src/agent-skills-export.ts apps/api/src/agent-skills-export.test.ts
```

Dans `apps/api/src/app.ts`, retirer l'import de `./agent-skills-export.js` et le bloc d'appel (lignes 129-132).

**Step 3 : Schéma Prisma**

Supprimer `model AgentSkill { … }` et le champ relation correspondant (chercher `AgentSkill[]`). Ajouter :

```prisma
model SpaceMarketplace {
  id               String   @id @default(cuid())
  spaceId          String
  space            Space    @relation(fields: [spaceId], references: [id], onDelete: Cascade)
  name             String
  url              String
  ref              String   @default("HEAD")
  commit           String
  installedPlugins Json     @default("[]")
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@unique([spaceId, name])
  @@map("space_marketplaces")
}
```

Sur `model Space`, ajouter `marketplaces SpaceMarketplace[]` à côté de `skillSettings`/`botSkills` (ligne ~180).

**Step 4 : Migration SQL**

```sql
-- Skills v2 phase 3: marketplaces live on the filesystem, DB row = lock (url/ref/commit/plugins).
CREATE TABLE "space_marketplaces" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "ref" TEXT NOT NULL DEFAULT 'HEAD',
  "commit" TEXT NOT NULL,
  "installedPlugins" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "space_marketplaces_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "space_marketplaces_spaceId_name_key" ON "space_marketplaces"("spaceId", "name");
ALTER TABLE "space_marketplaces" ADD CONSTRAINT "space_marketplaces_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Legacy skills table: exported to the filesystem at API boot since phase 2, no reader left.
DROP TABLE IF EXISTS "agent_skills";
```

Vérifier le nom réel de la table `Space` (`@@map`) dans le schéma avant d'écrire la FK.

**Step 5 : Générer, typer, tester**

```bash
pnpm --filter @rakazo/db exec prisma generate && pnpm --filter @rakazo/db exec prisma validate
pnpm --filter @rakazo/api check && pnpm --filter @rakazo/api test
```

Attendu : PASS, plus aucune référence à `agentSkill`/`AgentSkill` Prisma.

**Step 6 : Commit**

```bash
git add -A && git commit -m "chore(skills): drop agent_skills, add SpaceMarketplace, remove legacy export and orphans"
```

---

### Task 2 : Téléchargement sûr de tarballs GitHub (`github-tarball.ts`)

**Files:**
- Modify: `packages/adapters/package.json` (ajouter `"tar": "^7.5.22"` dans `dependencies`)
- Create: `packages/adapters/src/github-tarball.ts`
- Test: `packages/adapters/src/github-tarball.test.ts`

**Step 1 : Dépendance**

```bash
cd packages/adapters && pnpm add tar@^7.5.22 --prefer-offline && cd ../..
git diff --stat pnpm-lock.yaml
```

Attendu : lockfile modifié seulement pour `@rakazo/adapters` (le paquet est déjà présent).

**Step 2 : Test rouge**

```ts
import { mkdtemp, readdir, readFile, rm, symlink, writeFile, mkdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { create as tarCreate } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { downloadGithubTarball, parseGithubRepoUrl, resolveGithubCommit } from "./github-tarball.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tmp() {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-tarball-"));
  dirs.push(dir);
  return dir;
}

/** Builds `<repo>-<sha>/…` like codeload does, with a symlink to make sure we drop it. */
async function fixtureTarball(): Promise<Buffer> {
  const src = await tmp();
  const top = path.join(src, "repo-abc123");
  await mkdir(path.join(top, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(top, ".claude-plugin/marketplace.json"), '{"name":"acme","plugins":[]}');
  await mkdir(path.join(top, "plugins/p/skills/s"), { recursive: true });
  await writeFile(path.join(top, "plugins/p/skills/s/SKILL.md"), "---\nname: s\ndescription: d\n---\nbody");
  await symlink("/etc/passwd", path.join(top, "plugins/p/skills/s/link"));
  const out = path.join(src, "out.tgz");
  await tarCreate({ gzip: true, cwd: src, file: out }, ["repo-abc123"]);
  return readFile(out);
}

const fetchWith = (body: Buffer | string, status = 200, headers: Record<string, string> = {}) =>
  (async () => new Response(body, { status, headers })) as unknown as typeof fetch;

describe("parseGithubRepoUrl", () => {
  it("accepts https github urls with or without .git", () => {
    expect(parseGithubRepoUrl("https://github.com/acme/skills")).toEqual({ owner: "acme", repo: "skills" });
    expect(parseGithubRepoUrl("https://github.com/acme/skills.git/")).toEqual({ owner: "acme", repo: "skills" });
  });
  it("rejects anything else", () => {
    expect(() => parseGithubRepoUrl("https://gitlab.com/a/b")).toThrow(/github/i);
    expect(() => parseGithubRepoUrl("https://github.com/acme")).toThrow();
  });
});

describe("resolveGithubCommit", () => {
  it("asks the commits API for the sha", async () => {
    const calls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push(`${url} ${new Headers(init?.headers).get("accept")}`);
      return new Response("0123456789abcdef0123456789abcdef01234567");
    }) as unknown as typeof fetch;
    await expect(resolveGithubCommit({ owner: "acme", repo: "skills", ref: "main" }, f)).resolves.toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(calls[0]).toBe("https://api.github.com/repos/acme/skills/commits/main application/vnd.github.sha");
  });
  it("rejects non-2xx and non-sha bodies", async () => {
    await expect(resolveGithubCommit({ owner: "a", repo: "b", ref: "x" }, fetchWith("nope", 404))).rejects.toThrow(/404/);
    await expect(resolveGithubCommit({ owner: "a", repo: "b", ref: "x" }, fetchWith("<html>"))).rejects.toThrow(/sha/i);
  });
});

describe("downloadGithubTarball", () => {
  it("extracts files, strips the top dir and drops symlinks", async () => {
    const dest = await tmp();
    await downloadGithubTarball({ owner: "acme", repo: "repo", commit: "abc123" }, dest, { fetch: fetchWith(await fixtureTarball()) });
    expect(await readFile(path.join(dest, ".claude-plugin/marketplace.json"), "utf8")).toContain('"acme"');
    expect(await readdir(path.join(dest, "plugins/p/skills/s"))).toEqual(["SKILL.md"]);
    await expect(lstat(path.join(dest, "plugins/p/skills/s/link"))).rejects.toThrow();
  });
  it("aborts past maxBytes", async () => {
    const dest = await tmp();
    await expect(
      downloadGithubTarball({ owner: "a", repo: "r", commit: "c" }, dest, { fetch: fetchWith(await fixtureTarball()), maxBytes: 64 }),
    ).rejects.toThrow(/too large/i);
  });
});
```

**Step 3 : Vérifier l'échec**

```bash
pnpm --filter @rakazo/adapters test -- github-tarball
```

Attendu : FAIL, module introuvable.

**Step 4 : Implémentation**

```ts
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract as tarExtract } from "tar";

export type GithubRepo = { owner: string; repo: string };
const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
export const MAX_TARBALL_BYTES = 50 * 1024 * 1024;

export function parseGithubRepoUrl(input: string): GithubRepo {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Marketplace URL must be a valid https://github.com/<owner>/<repo> URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error("Only public GitHub repositories are supported (https://github.com/<owner>/<repo>).");
  }
  const [owner, rawRepo, ...rest] = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  const repo = rawRepo?.replace(/\.git$/, "");
  if (!owner || !repo || rest.length > 0 || !SEGMENT.test(owner) || !SEGMENT.test(repo)) {
    throw new Error("Marketplace URL must look like https://github.com/<owner>/<repo>.");
  }
  return { owner, repo };
}

/** Pins a ref (branch, tag, sha, HEAD) to a full commit sha via the GitHub REST API. */
export async function resolveGithubCommit(input: GithubRepo & { ref: string }, fetchImpl: typeof fetch): Promise<string> {
  if (!/^[A-Za-z0-9_.\/-]{1,200}$/.test(input.ref)) throw new Error("Invalid git ref.");
  const url = `https://api.github.com/repos/${input.owner}/${input.repo}/commits/${encodeURIComponent(input.ref)}`;
  const response = await fetchImpl(url, {
    headers: { accept: "application/vnd.github.sha", "user-agent": "rakazo-skills" },
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${input.owner}/${input.repo}@${input.ref}.`);
  const sha = (await response.text()).trim();
  if (!SHA.test(sha)) throw new Error("GitHub did not return a commit sha.");
  return sha;
}

/**
 * Streams `codeload.github.com/<o>/<r>/tar.gz/<commit>` into `destDir`, stripping the
 * `<repo>-<sha>/` top directory. Regular files and directories only: symlinks/hardlinks are
 * dropped, tar already refuses `..` and absolute paths. Aborts once `maxBytes` is exceeded.
 */
export async function downloadGithubTarball(
  input: GithubRepo & { commit: string },
  destDir: string,
  options: { fetch: typeof fetch; maxBytes?: number },
): Promise<void> {
  const maxBytes = options.maxBytes ?? MAX_TARBALL_BYTES;
  const url = `https://codeload.github.com/${input.owner}/${input.repo}/tar.gz/${input.commit}`;
  const response = await options.fetch(url, { headers: { "user-agent": "rakazo-skills" } });
  if (!response.ok || !response.body) throw new Error(`GitHub tarball download failed (${response.status}).`);
  let seen = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) return callback(new Error(`Marketplace tarball too large (> ${maxBytes} bytes).`));
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    limit,
    tarExtract({
      cwd: destDir,
      strip: 1,
      preservePaths: false,
      filter: (_path, entry) => entry.type === "File" || entry.type === "Directory",
    }),
  );
}
```

Si `Readable.fromWeb` pose un souci de types, caster en `any` localement avec un commentaire ; ne pas ajouter de dépendance.

**Step 5 : Vert**

```bash
pnpm --filter @rakazo/adapters test -- github-tarball && pnpm --filter @rakazo/adapters check && pnpm exec biome check --write packages/adapters/src/github-tarball.ts packages/adapters/src/github-tarball.test.ts
```

**Step 6 : Commit**

```bash
git add packages/adapters/package.json pnpm-lock.yaml packages/adapters/src/github-tarball.ts packages/adapters/src/github-tarball.test.ts
git commit -m "feat(skills): safe GitHub tarball download for marketplaces"
```

---

### Task 3 : Store marketplace sur le FS (`marketplace-store.ts`)

**Files:**
- Create: `packages/adapters/src/marketplace-store.ts`
- Test: `packages/adapters/src/marketplace-store.test.ts`
- Modify: `packages/core/src/skill-access.ts` (ajouter `marketplaceSkillKey`, `isMarketplaceSkillKey`, `defaultSkillAvailability`)
- Modify: `packages/adapters/src/index.ts:75-76` (ré-exporter le store)

**Step 1 : Helpers core (test dans `packages/core/src/skill-access.test.ts` s'il existe, sinon créer)**

```ts
export function marketplaceSkillKey(marketplace: string, plugin: string, slug: string): string {
  return `mkt:${marketplace}/${plugin}/${slug}`;
}
export function isMarketplaceSkillKey(key: string): boolean {
  return key.startsWith("mkt:");
}
/** Marketplace skills start hidden (design Q8); user skills stay visible to every bot. */
export function defaultSkillAvailability(key: string): SkillAvailability {
  return isMarketplaceSkillKey(key) ? "selected" : "all";
}
```

Test : `defaultSkillAvailability("mkt:a/b/c") === "selected"`, `("user:x") === "all"`, `marketplaceSkillKey("a","b","c") === "mkt:a/b/c"`.

**Step 2 : Test rouge du store**

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSkillMd } from "@rakazo/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  diffPluginTrees,
  installPluginFromCheckout,
  listMarketplaceSkills,
  marketplacesRoot,
  readMarketplaceManifest,
  removeInstalledPlugin,
} from "./marketplace-store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tmp() {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-mkt-"));
  dirs.push(dir);
  return dir;
}
/** A fake extracted repo: manifest + one plugin with a skill, a script, and ignored dirs. */
async function checkout(skillBody = "Steps") {
  const dir = await tmp();
  await mkdir(path.join(dir, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(dir, ".claude-plugin/marketplace.json"),
    JSON.stringify({ name: "Acme", plugins: [
      { name: "Writer", source: "./plugins/writer", description: "Writing helpers" },
      { name: "remote", source: { source: "github", repo: "x/y" } },
    ] }),
  );
  await mkdir(path.join(dir, "plugins/writer/skills/Blog-Post/scripts"), { recursive: true });
  await writeFile(path.join(dir, "plugins/writer/skills/Blog-Post/SKILL.md"), buildSkillMd({ name: "Blog post", description: "Write posts", body: skillBody }));
  await writeFile(path.join(dir, "plugins/writer/skills/Blog-Post/scripts/run.sh"), "echo hi");
  await mkdir(path.join(dir, "plugins/writer/commands"), { recursive: true });
  await writeFile(path.join(dir, "plugins/writer/commands/x.md"), "ignored");
  return dir;
}

describe("marketplace store", () => {
  it("parses the manifest, lowercases names and flags unsupported sources", async () => {
    const manifest = await readMarketplaceManifest(await checkout());
    expect(manifest.name).toBe("acme");
    expect(manifest.plugins).toEqual([
      { name: "writer", source: "./plugins/writer", description: "Writing helpers", supported: true },
      { name: "remote", source: null, description: undefined, supported: false },
    ]);
  });

  it("installs only skills/ and lists them with mkt: keys", async () => {
    const root = marketplacesRoot(await tmp(), "space1");
    const src = await checkout();
    await installPluginFromCheckout(root, "acme", src, await readMarketplaceManifest(src), "writer");
    const skills = await listMarketplaceSkills(root);
    expect(skills.map((s) => [s.id, s.name, s.source, s.readOnly])).toEqual([["mkt:acme/writer/blog-post", "Blog post", "plugin", true]]);
    await expect(readFile(path.join(root, "acme/plugins/writer/skills/blog-post/scripts/run.sh"), "utf8")).resolves.toBe("echo hi");
    await expect(readFile(path.join(root, "acme/plugins/writer/commands/x.md"))).rejects.toThrow();
  });

  it("rejects the whole plugin when a SKILL.md exceeds 100k", async () => {
    const root = marketplacesRoot(await tmp(), "space1");
    const src = await checkout("x".repeat(100_001));
    await expect(installPluginFromCheckout(root, "acme", src, await readMarketplaceManifest(src), "writer")).rejects.toThrow(/100/);
    expect(await listMarketplaceSkills(root)).toEqual([]);
  });

  it("removes an installed plugin", async () => {
    const root = marketplacesRoot(await tmp(), "space1");
    const src = await checkout();
    await installPluginFromCheckout(root, "acme", src, await readMarketplaceManifest(src), "writer");
    await removeInstalledPlugin(root, "acme", "writer");
    expect(await listMarketplaceSkills(root)).toEqual([]);
  });

  it("diffs installed vs candidate plugin trees", async () => {
    const before = await checkout("v1");
    const after = await checkout("v2");
    await rm(path.join(after, "plugins/writer/skills/Blog-Post/scripts/run.sh"));
    await writeFile(path.join(after, "plugins/writer/skills/Blog-Post/references/notes.md"), "n").catch(async () => {
      await mkdir(path.join(after, "plugins/writer/skills/Blog-Post/references"), { recursive: true });
      await writeFile(path.join(after, "plugins/writer/skills/Blog-Post/references/notes.md"), "n");
    });
    const changes = await diffPluginTrees(path.join(before, "plugins/writer/skills"), path.join(after, "plugins/writer/skills"));
    expect(changes.map((c) => [c.path, c.status])).toEqual([
      ["Blog-Post/SKILL.md", "modified"],
      ["Blog-Post/references/notes.md", "added"],
      ["Blog-Post/scripts/run.sh", "removed"],
    ]);
    expect(changes[0]?.before).toContain("v1");
    expect(changes[0]?.after).toContain("v2");
  });
});
```

**Step 3 : Vérifier l'échec**

```bash
pnpm --filter @rakazo/adapters test -- marketplace-store
```

**Step 4 : Implémentation**

```ts
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { marketplaceSkillKey, parseSkillMd } from "@rakazo/core";
import { z } from "zod";
import { getLogger } from "./logger.js"; // vérifier le chemin réel de getLogger dans adapters

export const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_SKILL_MD_BYTES = 100_000;
const IGNORED_PLUGIN_DIRS = ["commands", "agents", "hooks", ".mcp.json"];

export function marketplacesRoot(dataDir: string, spaceId: string): string {
  return path.join(dataDir, "skills", "marketplaces", spaceId);
}

const ManifestSchema = z.object({
  name: z.string().min(1),
  plugins: z.array(z.object({
    name: z.string().min(1),
    source: z.unknown(),
    description: z.string().optional(),
  })).default([]),
});

export type MarketplacePlugin = { name: string; source: string | null; description?: string; supported: boolean };
export type MarketplaceManifest = { name: string; plugins: MarketplacePlugin[] };

function safeName(raw: string, what: string): string {
  const name = raw.trim().toLowerCase();
  if (!SAFE_NAME.test(name)) throw new Error(`Invalid ${what} name "${raw}".`);
  return name;
}

/** Reads `.claude-plugin/marketplace.json` from an extracted checkout. Only relative `./` sources are installable (design Q6). */
export async function readMarketplaceManifest(checkoutDir: string): Promise<MarketplaceManifest> {
  const raw = await readFile(path.join(checkoutDir, ".claude-plugin", "marketplace.json"), "utf8").catch(() => {
    throw new Error("Repository has no .claude-plugin/marketplace.json.");
  });
  const parsed = ManifestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error("marketplace.json is invalid: expected { name, plugins: [{ name, source }] }.");
  return {
    name: safeName(parsed.data.name, "marketplace"),
    plugins: parsed.data.plugins.map((plugin) => {
      const relative = typeof plugin.source === "string" && plugin.source.startsWith("./") && !plugin.source.includes("..");
      return { name: safeName(plugin.name, "plugin"), source: relative ? (plugin.source as string) : null, description: plugin.description, supported: relative };
    }),
  };
}

export type MarketplaceSkillFile = {
  id: string; marketplace: string; plugin: string; slug: string;
  name: string; description: string; content: string; source: "plugin"; readOnly: true; updatedAt: Date;
};

export async function listMarketplaceSkills(root: string): Promise<MarketplaceSkillFile[]> {
  const out: MarketplaceSkillFile[] = [];
  for (const marketplace of await listDirs(root)) {
    for (const plugin of await listDirs(path.join(root, marketplace, "plugins"))) {
      const skillsDir = path.join(root, marketplace, "plugins", plugin, "skills");
      for (const slug of await listDirs(skillsDir)) {
        const file = path.join(skillsDir, slug, "SKILL.md");
        const content = await readFile(file, "utf8").catch(() => null);
        if (content === null) continue;
        const parsed = parseSkillMd(content);
        if ("error" in parsed) {
          getLogger().warn({ file, error: parsed.error }, "skipping invalid marketplace SKILL.md");
          continue;
        }
        out.push({
          id: marketplaceSkillKey(marketplace, plugin, slug), marketplace, plugin, slug,
          name: parsed.name, description: parsed.description, content, source: "plugin", readOnly: true,
          updatedAt: (await stat(file)).mtime,
        });
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function listDirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && SAFE_NAME.test(e.name.toLowerCase())).map((e) => e.name).sort();
}

/** Copies `<source>/skills/<slug>/**` into `<root>/<marketplace>/plugins/<plugin>/skills/<slug>/` (slug lowercased). Atomic per plugin: validates everything before touching the root. */
export async function installPluginFromCheckout(root: string, marketplace: string, checkoutDir: string, manifest: MarketplaceManifest, pluginName: string): Promise<void> {
  const plugin = manifest.plugins.find((p) => p.name === pluginName);
  if (!plugin) throw new Error(`Plugin "${pluginName}" is not in the marketplace.`);
  if (!plugin.source) throw new Error(`Plugin "${pluginName}" has an unsupported source (only paths inside the repository are supported).`);
  const pluginDir = path.resolve(checkoutDir, plugin.source);
  if (!pluginDir.startsWith(path.resolve(checkoutDir) + path.sep)) throw new Error("Plugin source escapes the repository.");
  const skillsDir = path.join(pluginDir, "skills");
  const slugs = await listDirs(skillsDir);
  if (slugs.length === 0) throw new Error(`Plugin "${pluginName}" has no skills/ directory.`);
  for (const slug of slugs) {
    const size = (await stat(path.join(skillsDir, slug, "SKILL.md")).catch(() => null))?.size;
    if (size === undefined) throw new Error(`Skill "${slug}" has no SKILL.md.`);
    if (size > MAX_SKILL_MD_BYTES) throw new Error(`Skill "${slug}" SKILL.md exceeds ${MAX_SKILL_MD_BYTES} bytes; plugin rejected.`);
  }
  for (const ignored of IGNORED_PLUGIN_DIRS) {
    if (await stat(path.join(pluginDir, ignored)).catch(() => null)) getLogger().info({ marketplace, plugin: pluginName, ignored }, "marketplace plugin content ignored (skills only)");
  }
  const target = path.join(root, marketplace, "plugins", pluginName, "skills");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const slug of slugs) {
    await cp(path.join(skillsDir, slug), path.join(target, slug.toLowerCase()), { recursive: true, dereference: false, filter: (src) => !isSymlinkSync(src) });
  }
}
```

`isSymlinkSync` : `lstatSync(src).isSymbolicLink()` inversé ; en pratique la Task 2 a déjà exclu les symlinks du tarball, ce filtre est ceinture + bretelles (`// ponytail:`).

```ts
export async function removeInstalledPlugin(root: string, marketplace: string, plugin: string): Promise<void> {
  await rm(path.join(root, marketplace, "plugins", plugin), { recursive: true, force: true });
}

export type FileChange = {
  path: string; status: "added" | "removed" | "modified";
  sizeBefore?: number; sizeAfter?: number;
  /** Text content, only when ≤ 100k and not binary. */
  before?: string; after?: string;
};

/** Recursive file-level diff between two skills/ trees. Paths are relative and sorted. */
export async function diffPluginTrees(beforeDir: string, afterDir: string): Promise<FileChange[]> {
  const [before, after] = await Promise.all([walk(beforeDir), walk(afterDir)]);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: FileChange[] = [];
  for (const rel of paths) {
    const a = before.get(rel);
    const b = after.get(rel);
    if (a && b && a.equals(b)) continue;
    changes.push({
      path: rel,
      status: !a ? "added" : !b ? "removed" : "modified",
      sizeBefore: a?.length, sizeAfter: b?.length,
      before: a ? asText(a) : undefined, after: b ? asText(b) : undefined,
    });
  }
  return changes;
}
async function walk(dir: string, prefix = ""): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) for (const [k, v] of await walk(path.join(dir, entry.name), rel)) out.set(k, v);
    else if (entry.isFile()) out.set(rel, await readFile(path.join(dir, entry.name)));
  }
  return out;
}
function asText(buffer: Buffer): string | undefined {
  if (buffer.length > MAX_SKILL_MD_BYTES || buffer.includes(0)) return undefined;
  return buffer.toString("utf8");
}
```

Note : `diffPluginTrees` compare des dossiers `skills/` (installé vs candidat) ; le slug installé est lowercased, le candidat non → le service (Task 4) compare après avoir installé le candidat dans un dossier temporaire via `installPluginFromCheckout(tmpRoot, …)`, ce qui normalise les deux côtés. Adapter le test du diff en conséquence si besoin (comparer deux racines installées).

**Step 5 : Export + vert**

Ajouter dans `packages/adapters/src/index.ts` : `export * from "./marketplace-store.js"; export * from "./github-tarball.js";`

```bash
pnpm --filter @rakazo/core test -- skill-access && pnpm --filter @rakazo/adapters test -- marketplace-store && pnpm --filter @rakazo/adapters check && pnpm --filter @rakazo/core check
pnpm exec biome check --write packages/core/src/skill-access.ts packages/adapters/src/marketplace-store.ts packages/adapters/src/marketplace-store.test.ts packages/adapters/src/index.ts
```

**Step 6 : Commit**

```bash
git add -A packages/core/src packages/adapters/src && git commit -m "feat(skills): marketplace filesystem store (manifest, install, list, diff)"
```

---

### Task 4 : Contrat + service `marketplaces.*`

**Files:**
- Modify: `packages/contracts/src/domain.ts` (après le bloc agentSkills ~445 : `SpaceMarketplaceSchema`, `MarketplacePluginSchema`, `MarketplaceFileChangeSchema`, `MarketplaceUpdateCheckSchema`)
- Modify: `packages/contracts/src/rpc.ts` (nouveau bloc `marketplaces` après `agentSkills` ~486)
- Create: `apps/api/src/marketplaces.ts`
- Test: `apps/api/src/marketplaces.test.ts`
- Modify: `apps/api/src/router.ts` (~411 création service ; handlers après `agentSkills` ~2323)

**Step 1 : Contrat**

```ts
// domain.ts
export const SpaceMarketplaceSchema = z.object({
  id: Id,
  name: z.string(),
  url: z.string(),
  ref: z.string(),
  commit: z.string(),
  installedPlugins: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SpaceMarketplace = z.infer<typeof SpaceMarketplaceSchema>;

export const MarketplacePluginSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  supported: z.boolean(),
  installed: z.boolean(),
});
export type MarketplacePlugin = z.infer<typeof MarketplacePluginSchema>;

export const MarketplaceFileChangeSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "removed", "modified"]),
  sizeBefore: z.number().optional(),
  sizeAfter: z.number().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
});
export const MarketplaceUpdateCheckSchema = z.object({
  commit: z.string(),
  upToDate: z.boolean(),
  changes: z.array(MarketplaceFileChangeSchema),
});
export type MarketplaceUpdateCheck = z.infer<typeof MarketplaceUpdateCheckSchema>;
```

```ts
// rpc.ts, dans appContract après agentSkills
marketplaces: {
  list: oc.input(z.object({})).output(z.array(SpaceMarketplaceSchema)),
  add: oc.input(z.object({ url: z.string().url().max(500), ref: z.string().min(1).max(200).optional() })).output(SpaceMarketplaceSchema),
  remove: oc.input(z.object({ marketplaceId: Id })).output(z.object({ ok: z.literal(true) })),
  plugins: oc.input(z.object({ marketplaceId: Id })).output(z.array(MarketplacePluginSchema)),
  installPlugin: oc.input(z.object({ marketplaceId: Id, plugin: z.string().min(1).max(64) })).output(SpaceMarketplaceSchema),
  removePlugin: oc.input(z.object({ marketplaceId: Id, plugin: z.string().min(1).max(64) })).output(SpaceMarketplaceSchema),
  checkUpdate: oc.input(z.object({ marketplaceId: Id })).output(MarketplaceUpdateCheckSchema),
  applyUpdate: oc.input(z.object({ marketplaceId: Id, commit: z.string().regex(/^[0-9a-f]{40}$/) })).output(SpaceMarketplaceSchema),
},
```

Vérifier comment `oc` et les erreurs (`ORPCError`/`errors`) sont déclarés dans le bloc `agentSkills` existant et copier le style exact.

```bash
pnpm --filter @rakazo/contracts check
```

**Step 2 : Test rouge du service**

Reprendre le mock prisma en mémoire de `apps/api/src/agent-skills.test.ts` (`table()`), ajouter une table `spaceMarketplace` (avec `findUnique` sur `{ spaceId_name }` et `{ id }`, `create`, `update`, `delete`, `findMany`) et `skillSetting`/`botSkill` (`deleteMany` par préfixe de `skillKey` via `startsWith`). Fetch factice : construit un tarball comme dans `github-tarball.test.ts` (extraire `fixtureTarball` dans un helper de test partagé `packages/adapters/src/test-tarball.ts` si pratique, sinon dupliquer) et répond selon l'URL (`api.github.com/...commits/...` → sha, `codeload...` → tarball).

Cas à couvrir :
- `add({ url })` : résout le sha, télécharge, écrit `.claude-plugin/marketplace.json` sous `<root>/<name>/`, crée la ligne `{ name, url, ref:"HEAD", commit, installedPlugins:[] }`. Doublon `name` → erreur « already added ».
- `add` avec URL non GitHub → erreur, aucune ligne créée.
- `plugins` : liste du manifest avec `installed`/`supported`.
- `installPlugin` : copie les skills, ajoute le nom à `installedPlugins`. Plugin non supporté → erreur.
- `removePlugin` : supprime le dossier, retire de `installedPlugins`, `deleteMany` des `skillSetting`/`botSkill` dont `skillKey` commence par `mkt:<m>/<p>/`.
- `checkUpdate` : sha identique → `{ upToDate: true, changes: [] }` ; sha différent avec contenu modifié → `changes` non vide (SKILL.md modifié).
- `applyUpdate({ commit })` : réinstalle chaque plugin installé, met à jour `commit`.
- `remove` : supprime dossier + ligne + settings `mkt:<m>/`.

**Step 3 : Implémentation `apps/api/src/marketplaces.ts`**

Squelette (compléter en suivant les tests) :

```ts
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Actor, MarketplacePlugin, MarketplaceUpdateCheck, SpaceMarketplace } from "@rakazo/contracts";
import {
  createSafeRemoteFetch, diffPluginTrees, downloadGithubTarball, installPluginFromCheckout,
  marketplacesRoot, parseGithubRepoUrl, readMarketplaceManifest, removeInstalledPlugin, resolveGithubCommit,
} from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";

export type MarketplacesDeps = { prisma: PrismaClient; dataDir: string; fetch?: typeof fetch };

export function createMarketplacesService(deps: MarketplacesDeps) {
  const root = (actor: Actor) => marketplacesRoot(deps.dataDir, actor.spaceId);

  /** Pins `ref` and extracts the repo into a fresh temp dir. Caller must `rm` it. */
  async function checkout(url: string, ref: string, commit?: string) {
    const repo = parseGithubRepoUrl(url);
    const safe = deps.fetch ? { fetch: deps.fetch, close: async () => {} } : createSafeRemoteFetch(); // vérifier la forme réelle du retour
    const dir = await mkdtemp(path.join(tmpdir(), "rakazo-mkt-"));
    try {
      const sha = commit ?? (await resolveGithubCommit({ ...repo, ref }, safe.fetch));
      await downloadGithubTarball({ ...repo, commit: sha }, dir, { fetch: safe.fetch });
      return { dir, commit: sha, manifest: await readMarketplaceManifest(dir) };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    } finally {
      await safe.close();
    }
  }

  async function owned(actor: Actor, marketplaceId: string) {
    const row = await deps.prisma.spaceMarketplace.findUnique({ where: { id: marketplaceId } });
    if (!row || row.spaceId !== actor.spaceId) throw new Error("Marketplace not found.");
    return row;
  }
  const plugins = (row: { installedPlugins: unknown }) => (Array.isArray(row.installedPlugins) ? (row.installedPlugins as string[]) : []);
  const toDto = (row: any): SpaceMarketplace => ({ id: row.id, name: row.name, url: row.url, ref: row.ref, commit: row.commit, installedPlugins: plugins(row), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });

  async function forgetSkillRows(actor: Actor, prefix: string) {
    await deps.prisma.skillSetting.deleteMany({ where: { spaceId: actor.spaceId, skillKey: { startsWith: prefix } } });
    await deps.prisma.botSkill.deleteMany({ where: { skillKey: { startsWith: prefix }, bot: { spaceId: actor.spaceId } } }); // vérifier la relation BotSkill→Bot
  }

  return {
    async list(actor: Actor) { /* findMany orderBy name, map toDto */ },
    async add(actor: Actor, input: { url: string; ref?: string }) {
      const ref = input.ref ?? "HEAD";
      const { dir, commit, manifest } = await checkout(input.url, ref);
      try {
        if (await deps.prisma.spaceMarketplace.findUnique({ where: { spaceId_name: { spaceId: actor.spaceId, name: manifest.name } } })) {
          throw new Error(`Marketplace "${manifest.name}" is already added.`);
        }
        const target = path.join(root(actor), manifest.name, ".claude-plugin");
        await mkdir(target, { recursive: true });
        await writeFile(path.join(target, "marketplace.json"), await readFile(path.join(dir, ".claude-plugin", "marketplace.json")));
        return toDto(await deps.prisma.spaceMarketplace.create({ data: { spaceId: actor.spaceId, name: manifest.name, url: input.url, ref, commit, installedPlugins: [] } }));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async plugins(actor: Actor, marketplaceId: string): Promise<MarketplacePlugin[]> {
      const row = await owned(actor, marketplaceId);
      const manifest = await readMarketplaceManifest(path.join(root(actor), row.name));
      const installed = new Set(plugins(row));
      return manifest.plugins.map((p) => ({ name: p.name, description: p.description, supported: p.supported, installed: installed.has(p.name) }));
    },
    async installPlugin(actor: Actor, marketplaceId: string, plugin: string) {
      const row = await owned(actor, marketplaceId);
      const { dir, manifest } = await checkout(row.url, row.ref, row.commit);
      try {
        await installPluginFromCheckout(root(actor), row.name, dir, manifest, plugin);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      const next = [...new Set([...plugins(row), plugin])].sort();
      return toDto(await deps.prisma.spaceMarketplace.update({ where: { id: row.id }, data: { installedPlugins: next } }));
    },
    async removePlugin(actor: Actor, marketplaceId: string, plugin: string) {
      const row = await owned(actor, marketplaceId);
      await removeInstalledPlugin(root(actor), row.name, plugin);
      await forgetSkillRows(actor, `mkt:${row.name}/${plugin}/`);
      return toDto(await deps.prisma.spaceMarketplace.update({ where: { id: row.id }, data: { installedPlugins: plugins(row).filter((p) => p !== plugin) } }));
    },
    async checkUpdate(actor: Actor, marketplaceId: string): Promise<MarketplaceUpdateCheck> {
      const row = await owned(actor, marketplaceId);
      const { dir, commit, manifest } = await checkout(row.url, row.ref);
      if (commit === row.commit) { await rm(dir, { recursive: true, force: true }); return { commit, upToDate: true, changes: [] }; }
      const staging = await mkdtemp(path.join(tmpdir(), "rakazo-mkt-stage-"));
      try {
        const changes = [];
        for (const plugin of plugins(row)) {
          await installPluginFromCheckout(staging, row.name, dir, manifest, plugin).catch(() => undefined); // plugin gone upstream → shows as removed
          const diff = await diffPluginTrees(path.join(root(actor), row.name, "plugins", plugin, "skills"), path.join(staging, row.name, "plugins", plugin, "skills"));
          changes.push(...diff.map((c) => ({ ...c, path: `${plugin}/${c.path}` })));
        }
        return { commit, upToDate: false, changes };
      } finally {
        await Promise.all([rm(dir, { recursive: true, force: true }), rm(staging, { recursive: true, force: true })]);
      }
    },
    async applyUpdate(actor: Actor, marketplaceId: string, commit: string) {
      const row = await owned(actor, marketplaceId);
      const { dir, manifest } = await checkout(row.url, row.ref, commit);
      try {
        await writeFile(path.join(root(actor), row.name, ".claude-plugin", "marketplace.json"), await readFile(path.join(dir, ".claude-plugin", "marketplace.json")));
        for (const plugin of plugins(row)) await installPluginFromCheckout(root(actor), row.name, dir, manifest, plugin);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return toDto(await deps.prisma.spaceMarketplace.update({ where: { id: row.id }, data: { commit } }));
    },
    async remove(actor: Actor, marketplaceId: string) {
      const row = await owned(actor, marketplaceId);
      await rm(path.join(root(actor), row.name), { recursive: true, force: true });
      await forgetSkillRows(actor, `mkt:${row.name}/`);
      await deps.prisma.spaceMarketplace.delete({ where: { id: row.id } });
      return { ok: true as const };
    },
  };
}
```

`// ponytail: checkUpdate + applyUpdate download the tarball twice; cache the extracted checkout if GitHub rate limits bite.` Les erreurs remontent comme dans `agent-skills.ts` (vérifier si le service lève `ORPCError` ou `Error` mappée dans le router, et faire pareil).

**Step 4 : Router**

Après `const agentSkills = createAgentSkillsService(...)` : `const marketplaces = createMarketplacesService({ prisma: deps.prisma, dataDir: deps.dataDir });`
Handlers dans le style de `agentSkills.*` (ligne ~2305) : `marketplaces: { list: authed.marketplaces.list.handler(({ context }) => marketplaces.list(context.actor)), … }`.

**Step 5 : Vert**

```bash
pnpm --filter @rakazo/api test -- marketplaces && pnpm --filter @rakazo/api check && pnpm exec biome check --write apps/api/src/marketplaces.ts apps/api/src/marketplaces.test.ts apps/api/src/router.ts packages/contracts/src
```

**Step 6 : Commit**

```bash
git add -A packages/contracts/src apps/api/src && git commit -m "feat(skills): marketplaces RPC (add, browse, install, update with diff, remove)"
```

---

### Task 5 : Skills marketplace dans le catalogue, les tools et le prompt

**Files:**
- Modify: `packages/adapters/src/skill-tools.ts` (`listAgentSkillRecords`, `onlyVisibleTo`, `skillUpdateFromTool`, `skillDeleteFromTool`)
- Test: `packages/adapters/src/skill-tools.test.ts`
- Modify: `apps/api/src/agent-skills.ts` (`owned`, `accessIndex`, `catalog`, `get`, `update`, `remove`)
- Test: `apps/api/src/agent-skills.test.ts`
- Modify: `packages/adapters/src/executor.ts` (~2882, indice de chemins)

**Step 1 : Tests rouges**

`skill-tools.test.ts` : écrire un skill marketplace sous `<dataDir>/skills/marketplaces/<spaceId>/acme/plugins/writer/skills/blog/SKILL.md` ; `listAgentSkillRecords` avec `botId` :
- sans `SkillSetting` → le skill `mkt:acme/writer/blog` **absent** (défaut `selected`) alors qu'un skill user sans setting est présent ;
- avec `botSkill { botId, skillKey: "mkt:acme/writer/blog", enabled: true }` → présent, `source: "plugin"`, `readOnly: true` ;
- `skillUpdateFromTool` / `skillDeleteFromTool` sur `mkt:` → résultat d'erreur « read-only ».

`agent-skills.test.ts` :
- `catalog` retourne l'entrée `mkt:…` avec `availability: "selected"`, `visibleBotIds: []` par défaut ;
- `setAccess({ skillId: "mkt:…", bot: { botId, enabled: true } })` → `visibleBotIds` contient le bot ;
- `get("mkt:…")` retourne le contenu ; `update`/`remove` sur `mkt:` → erreur read-only ;
- `owned` d'un autre space → not found.

**Step 2 : Implémentation**

`skill-tools.ts` :
```ts
const [userSkills, marketplaceSkills] = await Promise.all([
  listUserSkills(userSkillsRoot(deps.dataDir, owner.spaceId, owner.userId)),
  listMarketplaceSkills(marketplacesRoot(deps.dataDir, owner.spaceId)),
]);
// records: user → { id: userSkillKey(name), source: "user", readOnly: false }, mkt → tel quel
```
`onlyVisibleTo` : indexer `settings`/`botSkills` par `record.id` et utiliser `isSkillVisible({ availability: setting?.availability ?? defaultSkillAvailability(record.id), override })`.
`skillUpdateFromTool`/`skillDeleteFromTool` : garde en tête `if (isMarketplaceSkillKey(id)) return { error: "Marketplace skills are read-only; edit them upstream and update the marketplace." }` (respecter la forme de retour existante).

`agent-skills.ts` : `owned()` cherche aussi dans `listMarketplaceSkills`; `accessIndex.of(key)` (renommer l'argument, appeler avec `entry.id`), défaut `defaultSkillAvailability(key)` à la place de `"all"` (lignes ~166 et ~184) ; `catalog` concatène `marketplaceSkills` ; `get` gère `mkt:` ; `update`/`remove` refusent `readOnly`.

`executor.ts` (près de l'appel `formatSkillsCatalogInstruction`, ~2882) : ajouter une ligne au prompt :
```ts
"Skill files are mounted read-only in the sandbox: your skills under /skills/user/<skill-dir>/SKILL.md, marketplace skills under /skills/marketplaces/<marketplace>/plugins/<plugin>/skills/<slug>/ (SKILL.md, scripts/, references/)."
```
Uniquement si le provider est docker (`deps.sandboxKind === "docker"` ou équivalent ; sinon omettre la ligne — vérifier ce qui est disponible dans les deps de l'executor). Si aucun indicateur simple n'existe, ajouter la ligne sans condition avec `// ponytail: only docker mounts these; harmless hint elsewhere`.

**Step 3 : Vert**

```bash
pnpm --filter @rakazo/adapters test -- skill-tools && pnpm --filter @rakazo/api test -- agent-skills && pnpm --filter @rakazo/adapters check && pnpm --filter @rakazo/api check
pnpm exec biome check --write packages/adapters/src/skill-tools.ts packages/adapters/src/skill-tools.test.ts packages/adapters/src/executor.ts apps/api/src/agent-skills.ts apps/api/src/agent-skills.test.ts
```

**Step 4 : Commit**

```bash
git add -A packages/adapters/src apps/api/src && git commit -m "feat(skills): marketplace skills in catalog, access and skill tools (selected by default, read-only)"
```

---

### Task 6 : Montages RO dans les sandboxes Docker

**Files:**
- Modify: `infra/sandboxes/supervisor/src/computer-spec.ts:77-107` (`ComputerCreateInput.skillsBinds?: string[]`, concat dans `HostConfig.Binds`)
- Test: `infra/sandboxes/supervisor/src/computer-spec.test.ts`
- Modify: `infra/sandboxes/supervisor/src/index.ts:111-200` (schéma POST `/computers` + `userId`, calcul des binds, recréation si binds manquants)
- Test: `infra/sandboxes/supervisor/src/index.test.ts` (si le POST y est testé ; sinon test unitaire d'un helper `skillsBindsFor`)
- Modify: `packages/adapters/src/docker-sandbox.ts:108-135` (`userId: context.userId`)
- Modify: `packages/adapters/src/computer-lifecycle.ts:44-110` (`mkdir -p` des deux dossiers skills avant `provision`)

**Step 1 : Test rouge `computer-spec`**

```ts
it("appends read-only skills binds after the home bind", () => {
  const options = containerCreateOptions({ ...base, skillsBinds: ["/var/rakazo/skills/user/s/u:/skills/user:ro", "/var/rakazo/skills/marketplaces/s:/skills/marketplaces:ro"] });
  expect(options.HostConfig?.Binds).toEqual([
    "/var/rakazo/homes/abc:/home/rakazo",
    "/var/rakazo/skills/user/s/u:/skills/user:ro",
    "/var/rakazo/skills/marketplaces/s:/skills/marketplaces:ro",
  ]);
});
```

Attendu FAIL (binds = home seul). Implémentation : `Binds: [`${input.homePath}:/home/rakazo`, ...(input.skillsBinds ?? [])]`.

**Step 2 : Helper + test dans `index.ts`**

```ts
const PathSegment = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
// POST /computers body: { botId, homePath, spaceId: PathSegment, userId: PathSegment }

/** Skills mounts are derived from ids + dataDir, never from client paths (design Q10). */
export function skillsBindsFor(dataDir: string, spaceId: string, userId: string, translate: (p: string) => string): string[] {
  return [
    `${translate(path.join(dataDir, "skills", "user", spaceId, userId))}:/skills/user:ro`,
    `${translate(path.join(dataDir, "skills", "marketplaces", spaceId))}:/skills/marketplaces:ro`,
  ];
}
```

Test : `skillsBindsFor("/data", "s1", "u1", (p) => p.replace("/data", "/var/rakazo"))` → les deux chaînes attendues.

Dans le handler POST : `const skillsBinds = skillsBindsFor(dataDir, body.spaceId, body.userId, (p) => hostHomePath(p, runtimeInfo));` puis `containerCreateOptions({ …, skillsBinds })`. Dans la branche « conteneur existant » : reprendre uniquement si `image/network/user` correspondent **et** `skillsBinds.every((b) => info.HostConfig?.Binds?.includes(b))` ; sinon supprimer et recréer (réutiliser le chemin de suppression existant pour le cas image différente).

**Step 3 : Adapter + worker**

`docker-sandbox.ts` : body `{ botId, homePath, spaceId: context.spaceId, userId: context.userId }`.

`computer-lifecycle.ts` (`provisionComputer`, après `mkdir(homePath)`) :
```ts
// Docker would create missing bind sources as root; create them as the worker user first.
if (deps.dataDir) {
  await mkdir(userSkillsRoot(deps.dataDir, context.spaceId, context.userId), { recursive: true });
  await mkdir(marketplacesRoot(deps.dataDir, context.spaceId), { recursive: true });
}
```
Vérifier que `deps.dataDir` est bien passé par les 4 appelants (`executor.ts:1153`, `computer-lifecycle.ts:534`, `router.ts:1402`, `taught-skills.ts:153`) ; sinon le brancher depuis `deps.dataDir ?? "./data"` comme `skillDeps` dans l'executor.

**Step 4 : Vert**

```bash
cd infra/sandboxes/supervisor && pnpm exec vitest run --root ../../.. infra/sandboxes/supervisor/src && pnpm exec tsc --noEmit && cd ../../..
pnpm --filter @rakazo/adapters test -- docker-sandbox computer-lifecycle && pnpm --filter @rakazo/adapters check
pnpm exec biome check --write infra/sandboxes/supervisor/src packages/adapters/src/docker-sandbox.ts packages/adapters/src/computer-lifecycle.ts
```

Vérification manuelle (optionnelle, si Docker dispo) : `docker inspect <container> --format '{{json .HostConfig.Binds}}'` après un `computer.start` → 3 binds, les deux skills en `:ro`.

**Step 5 : Commit**

```bash
git add -A infra/sandboxes/supervisor/src packages/adapters/src && git commit -m "feat(sandbox): mount user and marketplace skills read-only in docker computers"
```

---

### Task 7 : Panneau web `SkillsOverlay`

**Files:**
- Create: `apps/web/src/pages/SkillsOverlay.tsx`
- Modify: `apps/web/src/pages/KnowledgeSection.tsx:242` (`export function AgentSkills`)
- Modify: `apps/web/src/pages/Shell.tsx` (lazy import ~236-241 ; state `skillsOpen` ~421 ; bouton sidebar après « Integrations » ~3007 ; montage overlay ~3938)
- Modify: `apps/web/src/locales/*` (via `pnpm --filter @rakazo/web intl:extract` puis `intl:compile`)

**Step 1 : Squelette du panneau**

Copier la structure de `PluginsOverlay.tsx` (Dialog 1080×760, header + `DialogClose`). Onglets via un état local `tab: "installed" | "marketplaces" | "browse"` et trois boutons (`data-testid="skills-tab-<tab>"`). Pas de composant Tabs si `@rakazo/ui-web` n'en expose pas.

- **Installed** : `<AgentSkills />` (exporté depuis `KnowledgeSection`). Ajouter dans l'entête de l'onglet un compteur `n / 50 skills visibles` et un avertissement si `> 50` (`<Trans>Only the first 50 skills are shown to the agent.</Trans>`), à partir de `rpc.agentSkills.list({ botId })` avec le bot actif (`activeBotId` déjà disponible dans Shell → passer en prop).
- **Marketplaces** : `rpc.marketplaces.list({})`. Formulaire `url` + `ref` (placeholder `HEAD`) → `rpc.marketplaces.add`. Par ligne : nom, url, `ref @ commit.slice(0,7)`, nb plugins installés, boutons **Check update** (→ `checkUpdate`, affiche `upToDate` ou la liste des changements + bouton **Apply update** → `applyUpdate({ commit })`), **Remove** (confirm `window.confirm`).
  Diff : `<ul>` de `changes` avec `path`, statut coloré, `sizeBefore → sizeAfter` ; pour `status === "modified"` avec `before`/`after` texte, un `<details>` ouvrant deux `<pre className="max-h-64 overflow-auto text-xs">` côte à côte (`grid grid-cols-2`).
- **Browse** : `<select>` de marketplace → `rpc.marketplaces.plugins({ marketplaceId })` ; carte par plugin : nom, description, badge « Unsupported source » si `!supported`, bouton **Install** / **Remove**. Sous un plugin installé, lister les skills du catalogue dont `id` commence par `mkt:<marketplace>/<plugin>/` (depuis `rpc.agentSkills.list`), avec rappel « Enable it per bot in Installed ».

Après chaque mutation : recharger `list`/`plugins` et appeler `onSkillsChanged?.()` (prop) pour que Shell rafraîchisse le slash picker (`refreshAgentSkills`).

**Step 2 : Shell**

```tsx
const SkillsOverlay = lazy(() => import("./SkillsOverlay").then((m) => ({ default: m.SkillsOverlay })));
const [skillsOpen, setSkillsOpen] = useState(false);
```
Bouton sidebar sous « Integrations » (icône lucide `Sparkles`), label `<Trans>Skills</Trans>`, `data-testid="open-skills"`. Montage : `{skillsOpen ? <Suspense fallback={null}><SkillsOverlay open onOpenChange={setSkillsOpen} botId={activeBotId} onSkillsChanged={refreshAgentSkills} /></Suspense> : null}` (copier le pattern de `pluginsOpen`).

**Step 3 : Lingui + types**

```bash
pnpm --filter @rakazo/web intl:extract && pnpm --filter @rakazo/web intl:compile && pnpm --filter @rakazo/web check
pnpm exec biome check --write apps/web/src/pages/SkillsOverlay.tsx apps/web/src/pages/Shell.tsx apps/web/src/pages/KnowledgeSection.tsx
```

**Step 4 : Vérification navigateur**

Lancer le dev web (preview existant) : ouvrir la sidebar → « Skills » → les trois onglets s'affichent ; Installed montre la liste existante ; Marketplaces : ajouter `https://gitlab.com/x/y` → message d'erreur GitHub-only visible.

**Step 5 : Commit**

```bash
git add -A apps/web/src && git commit -m "feat(web): Skills overlay with installed, marketplaces and browse tabs"
```

---

### Task 8 : e2e + intégration finale

**Files:**
- Create: `apps/web/e2e/skills-overlay.spec.ts`
- Modify: `docs/plans/2026-09-03-skills-system-design.md` §5 (ligne phase 3 → livrée, commit)

**Step 1 : e2e**

Avec les helpers de `apps/web/e2e/helpers.ts` (`signup`, `completeOnboarding`, `rpc`) :
- ouvrir « Skills » (`data-testid="open-skills"`), vérifier les trois onglets ;
- onglet Marketplaces : `rpc(page, "marketplaces/list", {})` vide ; soumettre une URL non GitHub → texte d'erreur visible ; aucune ligne créée ;
- onglet Installed : un skill créé via `rpc(page, "agentSkills/create", …)` apparaît.
Pas d'appel réseau GitHub en e2e (couvert par unit tests).

```bash
pnpm test:e2e -- --spec=skills-overlay
```

**Step 2 : Suite complète**

```bash
pnpm --filter @rakazo/core test && pnpm --filter @rakazo/adapters test && pnpm --filter @rakazo/api test && pnpm --filter @rakazo/contracts check && pnpm --filter @rakazo/web check
cd infra/sandboxes/supervisor && pnpm exec vitest run --root ../../.. infra/sandboxes/supervisor/src && pnpm exec tsc --noEmit
pnpm test:e2e -- --spec=skill-access && pnpm test:e2e -- --spec=slash-skills && pnpm test:e2e -- --spec=knowledge-panel
```

**Step 3 : Design doc**

Dans `docs/plans/2026-09-03-skills-system-design.md` §5, ligne phase 3 : statut livré + résumé des décisions (pas de lock file, onglets Installed/Marketplaces/Browse, montages RO calculés côté supervisor).

**Step 4 : Commit**

```bash
git add docs/plans/2026-09-03-skills-system-design.md apps/web/e2e/skills-overlay.spec.ts && git commit -m "test(skills): skills overlay e2e; mark phase 3 delivered in design doc"
```

---

## Ordre et parallélisme

- Task 1 d'abord (schéma). Tasks 2 → 3 → 4 en chaîne (adapters puis API). Task 5 dépend de 3. Task 6 indépendante (peut démarrer tout de suite). Task 7 dépend de 4 et 5. Task 8 dépend de tout.
- Worktrees séparés par ticket ; merge en rebase + `--ff-only` sur `main` du checkout principal.
