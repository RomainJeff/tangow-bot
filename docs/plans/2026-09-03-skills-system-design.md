# Skills system v2 — filesystem-first, scoping par bot, panneau + marketplaces

> Statut : **design / exploration**, à valider avant plan d'implémentation détaillé (format writing-plans).
> Date : 2026-09-03 — révisé 2026-09-04 après relecture externe (skillKey stable dès phase 1, rename, intégrité DB↔FS, mount restreint, cap body à l'install, diff scripts, marketplaces au niveau Space).
> Recheck 2026-09-05 sur l'arbre rebasé (19 commits upstream depuis la révision) : aucun changement fonctionnel côté skills/capabilities/mounts ; `BotSettings` extrait dans `shell/bot-panel.tsx`, `PluginsOverlay` a gagné les sections Installed/Featured et une prop `activeBotId` ; refs `file:line` réalignées.

## 0. TL;DR

Aujourd'hui les skills sont des lignes Postgres (`AgentSkill`), scopées `(spaceId, userId)`, visibles par **tous** les bots de l'utilisateur, éditées dans un textarea planqué dans *Bot → Advanced → Knowledge → Skills*. Rien ne touche le disque. Le mot « plugin » existe dans les enums mais n'a **aucun producteur**.

Cible :

1. **Scoping** : chaque skill a une disponibilité globale (`all` / `selected`) + chaque bot peut cocher/décocher dans sa config.
2. **Filesystem-first** : le contenu des skills vit en `SKILL.md` + fichiers annexes sous `DATA_DIR/skills/`, format Claude Code (`<name>/SKILL.md`, `scripts/`, `references/`). La DB ne garde que l'état d'activation/assignation.
3. **Panneau « Skills »** au même niveau que « Integrations » : liste des skills installées, sources (user / marketplace), ajout de marketplaces compatibles Claude Code (`.claude-plugin/marketplace.json`), install/update/remove de plugins.

Trois phases livrables indépendamment. Questions ouvertes en §6 — merci de répondre inline.

---

## 1. Existant (cartographie)

### 1.1 Deux choses s'appellent « skills »

| | `AgentSkill` | `TaughtSkill` |
|---|---|---|
| Nature | SKILL.md texte (recettes) | playbooks enregistrés (demo/record) |
| Scope | `(spaceId, userId)` — **pas de botId** | `(spaceId, botId, userId)` |
| Table | `agent_skills` (`schema.prisma:699`) | `taught_skills` (`schema.prisma:671`) |
| RPC | `agentSkills.{list,get,create,update,remove}` (`rpc.ts:452`) | `skills.*` (`rpc.ts:423`) |
| UI | `KnowledgeSection.tsx:239` (`AgentSkills`) | `SkillDraftCard.tsx` |

Ce document ne concerne que **`AgentSkill`**. `TaughtSkill` reste tel quel.

### 1.2 Chemin d'exécution actuel

- Chargement : `listAgentSkillRecords(prisma, {spaceId, userId})` (`packages/adapters/src/skill-tools.ts:84`) — unique point d'entrée, **aucun paramètre botId**. Concatène `BUILTIN_AGENT_SKILLS` (tableau **vide**, `builtin-skills.ts`) + rows DB.
- Injection dans le run (`packages/adapters/src/executor.ts`) :
  - `:2874` catalogue name+description dans les instructions système, **cappé à 50** (`agent-skill.ts:124`).
  - `:2879` `expandSkillReferencesInPrompt` inline le **corps complet** dans le prompt user sur `/Name` ou `@Name`.
  - Tools `skill_read/create/update/delete` toujours exposés (`builtin-tools.ts:487`, dispatch `executor.ts:2284`).
- Le commentaire « The Pi runtime already understands this format » (schema, core, contracts) est **faux aujourd'hui** : rien ne passe de dossier skills à Pi, tout est assemblage de prompt.

### 1.3 Briques réutilisables

- `parseSkillMd` / `buildSkillMd` (`packages/core/src/agent-skill.ts:64,92`) — parser YAML maison (~140 lignes, sous-ensemble : scalaires, block scalars, arrays inline, un niveau de nesting). Suffisant pour `name`/`description`/`allowed-tools`, fragile sur des SKILL.md tiers exotiques.
- `isSkillReadOnly(source)` — `builtin|plugin` = lecture seule, déjà enforcé côté API (`agent-skills.ts:225,285`) et tools (`skill-tools.ts:199,272`).
- **Pattern d'assignation par bot à copier** : `BotMcpServer` (`schema.prisma:996`, `@@unique([botId, serverId])`) + `mcp.assignments.{list,all,approve,replace}` (`rpc.ts:495`, `router.ts:2650-2768`) + re-check à l'exécution (`mcp-connector.ts:106-153`) + UI chips agents (`McpServersOverlay.tsx:199-212,452-470`) + copie dans `bots.duplicate` (`router.ts:717`).
- **Panneau à cloner** : `PluginsOverlay.tsx` (titre UI « Integrations ») — carte 1080×760 `:290`, search `:304`, `<details>` « Installed integrations » `:324` (grille 2 colonnes `:344`), section « Featured » `:349-360`, bouton « load more » `:454`, `<details>` advanced `:461`. Reçoit déjà `activeBotId` en prop (`:49`) → précédent pour un panneau conscient du bot courant. Câblage dans `Shell.tsx:236-240` (lazy), `:421` (state), `:2998` (bouton sidebar), `:3929-3938` (render).
- `CapabilityInstall` (`schema.prisma:736`) : `kind ∈ {skill,plugin,mcp,api,connection}` (`domain.ts:495`), `source`, `version`, `digest`, `config` — le schéma « install de marketplace » existe déjà, `kind:"skill"|"plugin"` n'est jamais écrit.
- Fetch distant sécurisé : `assertSafeRemoteUrl` / `createSafeRemoteFetch` (`remote-mcp.ts:117,136`), lecture bornée 2 Mo (`installed-connectors.ts:376-381`, `readBoundedText` `:620`).
- Chaîne RPC : zod dans `rpc.ts` → `authed.X.handler` dans `router.ts` → `rpc.X()` dans un `useEffect` (pas de React Query). Migrations SQL écrites à la main.

### 1.4 Réalités déploiement

- Docker Compose uniquement. `DATA_DIR=/data`, bind `../../data:/data`, partagé api + worker + supervisor (`infra/compose/docker-compose.yml:23,68,100`), `chown 1000:1000` par `data-init`.
- `data/` contient `homes/`, `home-revisions/`, `artifacts/`, `desktop-computers/`, `push-tokens/`. **Pas de dossier skills.**
- Supervisor traduit chemin conteneur → chemin hôte via le mount Docker (`infra/sandboxes/supervisor/src/index.ts:746-750`, garde `assertBotHomePath` `:739`) pour monter les homes dans les sandboxes siblings. Tout nouveau dossier à monter dans un sandbox doit passer par la même traduction.
- Image api (`infra/compose/Dockerfile`) **sans `git`**. Sandboxes desktop en ont.

### 1.5 Orphelins à nettoyer

- `skills-lock.json` + `.agents/skills/composio/` : zéro référence dans le code, commit initial. Artefacts de l'outillage Claude Code du mainteneur upstream. À supprimer ou à réutiliser comme format de lock (voir §4).
- `AgentHome` prisma model : mort (état home sur `Computer.homeKey/homeRevision`).

---

## 2. Axe 1 — Scoping par bot

### Modèle proposé

```
Skill (métadonnée, voir §3 pour où elle vit)
  availability: "all" | "selected"      # défaut global
BotSkill (join)
  botId, skillKey, enabled: boolean
  @@unique([botId, skillKey])
```

Résolution pour un run : `visible(bot, skill) = BotSkill[bot,skill].enabled ?? (skill.availability === "all")`.

- `availability = all` : dispo partout sauf opt-out explicite par bot (`enabled=false`).
- `availability = selected` : invisible sauf opt-in explicite (`enabled=true`).
- Un seul join table couvre les deux sens. Pas de flag « enabled global » séparé : désactiver globalement = `selected` + aucune ligne.

### `skillKey` : stable **dès la phase 1**

Le join référence une clé, pas un `AgentSkill.id` : en phase 2 les rows DB disparaissent et l'identité devient le dossier FS. Si la phase 1 pointait sur `id`, la phase 2 re-migrerait toutes les lignes `BotSkill`. Donc dès la phase 1 :

- `skillKey = "user:" + slug(name)` — `slug` = `lower(name)` normalisé (même règle que l'index unique `lower(name)` existant), et futur nom de dossier FS.
- Phase 3 ajoute `"mkt:<marketplace>/<plugin>/<slug>"`.
- La phase 2 devient un pur déplacement de contenu, zéro touche au join.

### Renommage

Sur FS, identité = nom de dossier ; renommer = nouvelle clé. Règle :

- **Clé immuable** (comme Claude Code : pas de rename, delete + create).
- Exception pragmatique : `skills.update` / `skill_update` avec un nouveau `name` fait, **dans la même transaction**, `mv` du dossier + `updateMany` des `BotSkill`/`SkillSetting` vers la nouvelle clé. C'est trois lignes et ça évite qu'un rename dans l'UI perde silencieusement les assignations.
- Un `mv` manuel sur le disque = orphelin, couvert par la règle d'intégrité ci-dessous.

### Intégrité DB ↔ FS (rows pendantes)

Un fichier peut disparaître sans passer par l'API : suppression à la main, update de marketplace qui retire une skill, marketplace supprimée. Sémantique :

- Les lignes `BotSkill` / `SkillSetting` dont la clé n'existe plus dans le catalogue FS sont **tolérées et ignorées** à la lecture (le catalogue FS est la source ; on joint dessus, jamais l'inverse).
- **GC explicite** : `skills.remove`, `marketplaces.removePlugin`, `marketplaces.update` (pour les clés disparues) et `marketplaces.remove` suppriment les lignes correspondantes dans la même transaction.
- Le panneau n'affiche jamais une clé pendante ; un compteur « N assignations orphelines » + bouton « Nettoyer » dans la section avancée suffit pour les cas hors-API. `ponytail: pas de job périodique, GC au write + bouton`.

### Où ça se branche

- `listAgentSkillRecords(prisma, {spaceId, userId, botId})` — ajouter `botId`, filtrer. Un seul seam, tous les appelants (`executor.ts:914`, routines `executor.ts:677`, `router.ts:2286` via `agentSkills.*`, `Shell.tsx:1013` picker slash) passent le bot courant.
- Tools `skill_*` : `skill_read` ne doit lire que les skills visibles du bot ; `skill_create` crée en `availability=selected` + `BotSkill[currentBot]=true` (le bot qui crée une skill l'a pour lui, pas pour ses voisins).
- `bots.duplicate` copie les `BotSkill`.
- UI : chips agents sur chaque carte skill (pattern `McpServersOverlay`) **et** section « Skills » dans `BotSettings` (`shell/bot-panel.tsx:450` `<details>` Advanced) listant toutes les skills avec toggle — les deux vues écrivent la même table.

### Défaut à la migration

Aujourd'hui = tout visible. Migration : `availability = "all"` pour toutes les skills existantes → **zéro changement de comportement** le jour 1. Écart volontaire avec MCP (défaut opt-in) : une skill est du texte, pas des credentials.

### Alternatives écartées

- **Tableau `botIds[]` sur la skill** : pas de contrainte d'unicité, pas de FK cascade sur suppression de bot, pas de pattern existant. Non.
- **Aucun défaut global, uniquement join (copie stricte de MCP)** : casse le comportement actuel, force N clics pour une nouvelle skill. Non.

---

## 3. Axe 2 — Filesystem-first

### Layout proposé

```
DATA_DIR/skills/
  user/<spaceId>/<userId>/<skill-name>/SKILL.md       # skills créées à la main ou par les bots
                                        scripts/…
                                        references/…
  marketplaces/<spaceId>/<marketplace-name>/            # clone/tarball d'une marketplace — niveau Space (Q1)
    .claude-plugin/marketplace.json
    plugins/<plugin>/skills/<skill-name>/SKILL.md
  marketplaces/<spaceId>/skills.lock.json               # marketplaces installées : url, ref, commit, digest
```

Identité d'une skill = **`skillKey`** stable (défini en §2) : `user:<slug>` ou `mkt:<marketplace>/<plugin>/<slug>`. C'est cette clé qu'utilise `BotSkill`. Le `name` affiché reste le frontmatter.

### Ce qui reste en DB

Seulement l'état mutable et transactionnel :

- `BotSkill` (join ci-dessus).
- `SkillSetting` `{ spaceId, userId, skillKey, availability }` — ou colonne sur un enregistrement d'index (voir Q3).
- Marketplaces installées : une ligne par marketplace, **au niveau Space**. `CapabilityInstall` a un `userId` obligatoire → soit le rendre nullable (`userId IS NULL` = ressource Space), soit une petite table `SpaceMarketplace { spaceId, name, url, ref, commit, installedPlugins Json }`. Recommandation : **table dédiée** — première ressource partagée entre membres d'un Space dans le codebase, mieux vaut ne pas la cacher dans une table `(spaceId, userId)`. `version`/`digest` de `CapabilityInstall` restent le modèle.

**Supprimé** : `AgentSkill.content` (et à terme la table `agent_skills`). Migration one-shot : export chaque row en `user/<space>/<user>/<name>/SKILL.md` via `buildSkillMd`, puis drop.

### Chargement

- Scan `readdir` à chaque run + cache mémoire keyed `mtime` (pas de watcher, pas de chokidar — `ponytail: scan+mtime, watcher si latence mesurée`). Un run charge ~dizaines de fichiers, négligeable.
- Parse via `parseSkillMd` existant. Fichier invalide → skill ignorée + warning visible dans le panneau (pas de crash de run).
- Le catalogue système ne compte que les skills **visibles du bot** → le cap 50 redevient tenable. Si dépassé : tronquer + ajouter un tool `skill_list` (voir Q7).
- **Cap du corps** : `expandSkillReferencesInPrompt` inline le `SKILL.md` complet dans le prompt sur `/Name`. Le cap 100k chars (`agent-skills.ts:57`) n'est enforcé qu'à la création → l'enforcer aussi **à l'install marketplace, en rejet** (pas troncation : une skill tronquée est une skill cassée). Les `references/` et `scripts/` ne sont pas inlinés — ils restent sur disque et le bot les lit à la demande — donc pas de cap sur eux, juste la borne taille du tarball.

### Fichiers annexes dans le sandbox

Une skill Claude Code peut référencer `scripts/foo.py`. Pour que le bot puisse l'exécuter, le dossier doit être visible **dans le sandbox**. Deux options :

| Option | Mécanisme | Coût | Limite |
|---|---|---|---|
| **A. Mount RO** (recommandé) | Supervisor bind-mount **deux** dossiers en lecture seule : `skills/user/<spaceId>/<userId>` → `/skills/user` et `skills/marketplaces/<spaceId>` → `/skills/marketplaces`, via la traduction de chemin existante (`supervisor/src/index.ts:746`). **Jamais `DATA_DIR/skills` entier** : ça exposerait les skills des autres users du Space. | ~30 lignes supervisor + prompt : « skills disponibles sous `/skills/…` » | Le bot voit les fichiers des skills du user et des marketplaces du Space, y compris celles non assignées à ce bot. Acceptable ? (Q5) |
| B. Copie dans le home | À `checkout`, copier les skills visibles sous `<home>/.skills/` | Filtrage exact par bot | Home keyé par `Computer.homeKey`, partagé entre bots d'un team computer → filtrage cassé de toute façon ; duplication disque ; sync des updates |

Phase 1 peut vivre **sans** ni A ni B (skills texte-only, comme aujourd'hui). A arrive avec les marketplaces (phase 3), où les scripts deviennent réels.

### Sécurité

- Tout ce qui est sous `DATA_DIR/skills` est écrit par l'API uniquement ; chemins passés par `safeJoin`/containment comme `home.ts:213` (`safeJoin`).
- Une skill = instruction injectée dans le prompt avec les credentials du bot. Une marketplace = **code tiers**. Conséquences non négociables :
  - Install/update d'une marketplace = action explicite dans le panneau, jamais automatique.
  - Pin sur commit sha (`digest`). « Update » montre le **diff complet** avant application : SKILL.md **et** `scripts/`, `references/`, fichiers ajoutés/supprimés avec tailles. Le code malveillant vivra dans `scripts/`, pas dans le frontmatter — un diff limité aux SKILL.md ne protège de rien.
  - Cap 100k chars sur chaque `SKILL.md` à l'install (rejet du plugin entier si dépassé), borne taille sur le tarball, extraction sans symlinks ni `..`.
  - Skills marketplace en lecture seule (`source:"plugin"` déjà enforcé).
  - Défaut `availability = selected` pour les skills marketplace (opt-in par bot), `all` pour les skills user. (Q4)
  - Marketplaces au niveau Space (Q1) : tout membre peut en ajouter, donc tout membre peut mettre des instructions à portée des bots des autres. Le `selected` par défaut est ce qui rend ça acceptable : rien n'atteint un bot sans que son propriétaire l'ait coché. Ne jamais ajouter un défaut `all` pour les skills marketplace tant qu'il n'y a pas de rôles dans le Space.

### Alternatives écartées

- **Tout en fichiers, y compris l'assignation** (`skills.json` par bot) : deux writers (UI + tools) sur un JSON sans transaction, race sur `bots.duplicate`, pas de cascade sur delete bot. La DB est là pour ça. Non.
- **Garder la DB comme source + export FS miroir** : deux sources de vérité, c'est exactement ce que la demande veut éviter. Non.
- **Skills dans le home du bot** (`<home>/.skills/`) : home keyé par computer, pas par bot ; partagé en team scope. Non comme source primaire.

---

## 4. Axe 3 — Panneau Skills + marketplaces

### Panneau

Nouvelle overlay `SkillsOverlay.tsx`, clone structurel de `PluginsOverlay.tsx`, bouton sidebar à côté de « Integrations » (`Shell.tsx:2998`). Nom UI : **« Skills »** (le mot « Plugins » désigne déjà les apps Composio dans les textes — collision de vocabulaire à éviter).

Contenu :

1. **Installées** — cartes : nom, description, badge source (`user` / `<marketplace>/<plugin>`), disponibilité (`all`/`selected`), chips agents cliquables (pattern MCP), état (ok / fichier invalide + erreur), actions : éditer (user only), supprimer, ouvrir le dossier (liste fichiers).
2. **Marketplaces** — liste des marketplaces ajoutées (nom, URL, ref, commit, date), bouton « Update » (diff puis apply), « Remove ». Formulaire « Add marketplace » : URL git (GitHub `owner/repo` ou URL complète) + ref optionnel.
3. **Parcourir** — pour une marketplace ajoutée : plugins listés depuis `marketplace.json`, avec nombre de skills, bouton « Install » par plugin (installe ses skills, crée `CapabilityInstall kind:"plugin"`).
4. **Nouvelle skill** — éditeur SKILL.md (reprendre `KnowledgeSection.tsx:239+`, ajouter validation live via `parseSkillMd` + champs name/description dérivés).

`KnowledgeSection` onglet Skills : soit supprimé, soit réduit à la liste des skills **visibles de ce bot** avec toggles (même data que la section BotSettings). Recommandation : réduit, pas supprimé — c'est là que l'utilisateur regarde ce qu'un bot « sait ».

### Format marketplace Claude Code

```
<repo>/.claude-plugin/marketplace.json
{
  "name": "acme-tools",
  "owner": { "name": "…" },
  "plugins": [
    { "name": "data-viz", "source": "./plugins/data-viz", "description": "…", "version": "1.2.0" },
    { "name": "remote",   "source": { "source": "github", "repo": "acme/remote-plugin" } }
  ]
}
<plugin>/.claude-plugin/plugin.json
<plugin>/skills/<skill-name>/SKILL.md   ← seul dossier consommé
```

Périmètre v1 : **skills uniquement**. `commands/`, `agents/`, `hooks/`, `.mcp.json` des plugins sont ignorés (loggés comme « non supporté »). Sources supportées : chemin relatif dans la marketplace + `github` (Q6).

### Fetch

Image api sans `git`. Deux options :

| | Mécanisme | Pour | Contre |
|---|---|---|---|
| **A. Tarball HTTPS** (recommandé v1) | `https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>` via `createSafeRemoteFetch`, borne taille (ex. 50 Mo), extraction sans symlinks/`..` | Zéro dépendance, réutilise le fetch sécurisé, sha résolu via API GitHub `commits/<ref>` | GitHub only (GitLab/Bitbucket ont des équivalents, ajout trivial plus tard) |
| B. `git clone --depth 1` | Ajouter `git` à l'image api, `execFile` | Tout hôte git, sha natif | Nouvelle dep image, process externe dans l'api, gestion creds pour repos privés |

Repos privés : hors périmètre v1 (Q6).

### RPC à ajouter

```
skills.list                → catalogue FS + settings + assignations (remplace agentSkills.list)
skills.get / create / update / remove   (user only pour les 3 derniers)
skills.setAvailability     { skillKey, availability }
skills.assignments.all / replace        (copie mcp.assignments)
skills.files               { skillKey } → arbre de fichiers (lecture)
marketplaces.list / add / update / remove
marketplaces.plugins       { marketplace } → plugins + skills déclarés
marketplaces.installPlugin / removePlugin
```

`agentSkills.*` gardé en alias déprécié le temps de migrer le composer slash (`Shell.tsx:1013`) et les e2e (`slash-skills.spec.ts`, `knowledge-panel.spec.ts`).

---

## 5. Phasage

| Phase | Livrable | Dépend de | Taille |
|---|---|---|---|
| **1. Scoping** | `BotSkill(skillKey = "user:<slug>")` + `SkillSetting.availability`, `listAgentSkillRecords(botId)`, rename cascade, chips agents dans `KnowledgeSection`, `bots.duplicate`, e2e — plan : `docs/plans/2026-09-05-skills-scoping-phase1.md`, tickets : `.scratch/skills-scoping-phase1/issues/`. Livré : merge `3defa0ab` (2026-09-05). Simplification : pas de section Skills séparée dans `BotSettings`, `KnowledgeSection` (déjà dans BotSettings > Advanced) porte les chips. | rien | S/M — table + 1 seam + UI toggles, DB inchangée sinon |
| **2. Filesystem** | `DATA_DIR/skills/user/…`, loader FS + cache mtime, migration export DB→FS + drop `content`, tools `skill_*` réécrits sur FS, GC rows pendantes, éditeur avec validation | 1 | M/L — touche executor, tools, API, migration |
| **3. Panneau + marketplaces** | `SkillsOverlay`, `SpaceMarketplace` (add/update/remove/install plugin), tarball fetch + caps, lock, mount RO restreint dans sandboxes, diff complet à l'update | 2 | L |

Phase 1 seule est déjà utile et sans risque. L'ordre 1→2→3 évite de migrer deux fois le modèle. Chaque phase → plan writing-plans séparé (tâches TDD).

---

## 6. Questions ouvertes

Réponds inline (CriticMarkup) ou en vrac. Défaut proposé entre crochets.

**Q1. Niveau des marketplaces — par user ou par Space ?**
Tout est isolé `(spaceId, userId)` aujourd'hui. Skills user : `skills/user/<spaceId>/<userId>/…`, pas de débat. Marketplaces : par user dupliquerait le clone × N users et amplifierait les updates × N ; une marketplace est de l'infra, pas un goût personnel. **Défaut révisé : niveau Space** (`skills/marketplaces/<spaceId>/`, table `SpaceMarketplace`). Conséquences assumées : première ressource partagée entre membres d'un Space (nouveau concept), tout membre peut add/update/remove (pas de rôles), et c'est le `selected` par défaut qui protège les bots des autres. **Tranché 2026-09-05 (Romain) : niveau Space, en temps 1.** Table `SpaceMarketplace`, dossier `skills/marketplaces/<spaceId>/`.

**Q2. Défaut d'`availability` pour les skills créées par un bot via `skill_create` ?**
**Tranché 2026-09-05 (Romain) : `selected`** + assignée au bot créateur. Skills créées à la main dans le panneau : défaut `all`. Skills existantes migrées : `all` (comportement conservé). Conséquence à assumer : une routine du bot B qui référence `@Skill` créée par le bot A cesse de l'expander (la mention reste texte brut, le run ne casse pas). Documenter dans le changelog + afficher un warning dans l'éditeur de routine quand la skill mentionnée n'est pas visible du bot.

**Q3. Où vit `availability` ?**
(a) table DB `SkillSetting {skillKey, availability}` ; (b) frontmatter `SKILL.md` (`rakazo: { availability: all }`) — filesystem-first jusqu'au bout, mais on écrit dans un fichier marketplace read-only à chaque toggle → impossible pour les skills `plugin`. [défaut : (a) DB]

**Q4. Skills marketplace : `selected` (opt-in par bot) par défaut ?**
[défaut : oui, sécurité. Coût : N clics par install]

**Q5. Mount RO dans les sandboxes (option A §3) — acceptable que le bot voie les fichiers des skills du user + marketplaces du Space non assignées à lui ?**
Mount restreint à `user/<spaceId>/<userId>` + `marketplaces/<spaceId>` (jamais le dossier entier, fuite inter-users sinon). Alternative : mount par skill assignée (N binds, complexité supervisor). [défaut : mount restreint, le filtrage par bot reste au niveau prompt]

**Q6. Sources marketplace v1 : GitHub public tarball seulement ?**
Repos privés (token), GitLab, URL git arbitraire → v2 ? [défaut : GitHub public v1]

**Q7. Cap 50 skills dans le catalogue système.**
Garder + tronquer avec warning dans le panneau, ou ajouter tool `skill_list` paginé + laisser le bot chercher ? [défaut : garder cap, compter uniquement les visibles, warning UI]

**Q8. `TaughtSkill` — hors périmètre confirmé ?**
Doit-il apparaître dans le panneau Skills (lecture) pour cohérence, ou reste-t-il dans son coin (teach flow) ? [défaut : hors périmètre]

**Q9. Compat mobile/desktop.**
Skills n'apparaissent que dans `apps/web`. Panneau web-only OK ? Le picker `/Name` mobile (`apps/mobile/app/thread.tsx`) doit-il filtrer par bot en phase 1 ? [défaut : web-only panneau ; picker mobile filtré par bot si l'endpoint est partagé, sinon v2]

**Q10. Lock file.**
Réutiliser le format `skills-lock.json` orphelin (`source`, `sourceType`, `skillPath`, `computedHash`) pour `skills.lock.json`, ou format maison `{marketplaces: {name: {url, ref, commit, installedPlugins}}}` ? [défaut : maison, l'ancien est un format d'outil externe et pin des skills unitaires, pas des marketplaces]

**Q11. Upstream.**
Fork de `elie222/rakazo`. Phase 1 (scoping) est PR-able upstream telle quelle. Phases 2–3 changent le modèle de stockage — viser upstream ou rester fork-only ? Ça conditionne le soin sur la migration et la rétro-compat `agentSkills.*`. [défaut : phase 1 upstream-friendly, 2–3 fork d'abord]
