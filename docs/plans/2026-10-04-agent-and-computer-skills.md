# Managed skills : `agent` (Pi) + `computer` (coding agents) — Plan
> **For Claude:** contrat d'implémentation. Les décisions de la section 2 ne se rouvrent pas dans une PR.

**Goal :** deux familles de skills **versionnées dans le repo**, livrées avec l'image `app` et montées en lecture seule dans le computer Docker. Seules les skills **computer** sont branchées sur le coding agent (OpenCode).

| Famille | Source repo | Consommateur | Où il les lit |
|---|---|---|---|
| **`agent`** | `skills/agent/<slug>/SKILL.md` | **Pi** (harness du bot, worker) | catalogue + `skill_read`, depuis `/app/skills/agent` dans l'image `app` ; fichiers (`scripts/`, `references/`) sur `/managed-skills/agent` dans le computer, accessibles par le tool `shell` de Pi |
| **`computer`** | `skills/computer/<slug>/SKILL.md` | **OpenCode** (dans le computer) | `/managed-skills/computer` → `~/.config/opencode/skills` |

Les `agent` s'ajoutent aux skills user + marketplace. Les computer ne passent **pas** par Pi (pour le moment), et les `agent` ne sont **pas** branchées sur OpenCode.

* * *
## 0. Terminologie

Deux familles de **managed skills** : versionnées dans `skills/` à la racine du repo, en lecture seule pour l'utilisateur, livrées avec l'image `app`. Elles s'ajoutent aux skills de l'utilisateur et des marketplaces. Le nom de la famille dit **qui les lit**.

| Famille | Dossier | Pour qui | Où elles vivent à l'exécution |
|---|---|---|---|
| **`agent`** | `skills/agent/` | **L'agent** : le harness du bot (Pi aujourd'hui), qui tourne dans le worker | Catalogue dans le prompt + `skill_read`, côté worker. Les fichiers (`scripts/`, `references/`) sont montés sur `/managed-skills/agent` dans le computer, parce que le tool `shell` de Pi s'exécute là-bas. Même mécanique que les skills user et marketplace aujourd'hui. Non branchées sur les coding agents. |
| **`computer`** | `skills/computer/` | **Le ou les coding agents** qui tournent sur le computer de l'agent (OpenCode aujourd'hui, Claude Code / Codex demain) | Montées sur `/managed-skills/computer` dans le computer et branchées sur le dossier de skills du coding agent. Absentes du catalogue de Pi. |

Règle pour ranger une nouvelle skill : si elle guide **le bot** (comment parler à l'utilisateur, déléguer, utiliser ses tools Rakazo), elle va dans `agent`. Si elle guide **un coding agent dans un repo** (tests, PR, debug), elle va dans `computer`.

---

## 1. Ce que l'exploration a établi
- **Pi tourne dans le worker** (image `app`, `docker-compose.images.yml:165`). Le computer est une autre image (`infra/sandboxes/computer/Dockerfile`) : les mains distantes du bot.
  
- **Le concept de skill `agent` existe déjà sous le nom** `builtin` : `packages/adapters/src/builtin-skills.ts` (1 skill, « Interrogate », en string TS). `skill-tools.ts:46` les expose en `builtin:<name>`, `readOnly: true`. `mergeBuiltinSkills` (`skill-tools.ts:98`) : un skill user du même nom shadow le builtin. La visibilité par bot (`SkillSetting` / `BotSkill`) s'applique déjà aux builtins.
  
- **Limite actuelle des builtins** : string en mémoire → pas de `scripts/`, pas de `references/`, pas de fichier montable dans le computer.
  
- **L'image** `app` **contient tout le repo** : `COPY --chmod=755 . .` (`infra/compose/Dockerfile`). Un dossier `skills/` à la racine sera donc à `/app/skills/` dans le worker et le supervisor **en prod** (`docker-compose.images.yml`). **En dev**, le supervisor est buildé depuis `infra/sandboxes/supervisor/Dockerfile` (`docker-compose.yml:39-42`), qui ne copie que `packages/{contracts,core,logging}` et le supervisor : il faut y ajouter `COPY skills skills`.
  
- **Les mounts skills** sont calculés par `skillsBindsFor(dataDir, spaceId, userId)` (`infra/sandboxes/supervisor/src/index.ts:156`). Ce sont des binds **depuis le host** (`translate` = `hostHomePath`). On ne peut pas binder un chemin de l'image `app` dans un conteneur frère : la source doit exister sur le host, donc sous `DATA_DIR`.
  
- **Le conteneur est recréé si les binds changent** (`index.ts:215`) : ajouter un bind migre les computers existants au prochain provision. Cette branche n'est pas testée aujourd'hui : test à ajouter en PR 2.
  
- **L'image computer est buildée avec** `context: infra/sandboxes/computer` (`publish-server-image.yml:68`). Elle ne voit pas `skills/` à la racine. On passe donc par le mount, pas par un `COPY` (et c'est ce qu'on veut : MAJ des skills sans rebuild du computer).
  
- **OpenCode** n'est pas dans l'image. Node 22 + git + gh y sont déjà (commit d445ba11). D'après sa doc, il lit les skills globales dans `~/.config/opencode/skills`, `~/.claude/skills` et `~/.agents/skills`.
  
- **`BUILTIN_AGENT_SKILLS` a deux consommateurs** : `skill-tools.ts:46` (catalogue Pi) et `apps/api/src/agent-skills.ts:61-72` (`builtinCatalog()`, liste des skills côté UI, picker `/`, `SkillSetting`).
  
- **`shell` a un timeout** : 5 min par défaut (`packages/core/src/sandbox-command.ts:1`, `SANDBOX_COMMAND_TIMEOUT_MS`), 60 min max.
  

* * *
## 2. Decisions already made
1. **Source unique = le repo.** `skills/agent/` et `skills/computer/` à la racine, format `SKILL.md` standard (frontmatter `name`, `description`). Les deux familles peuvent avoir `scripts/` et `references/`.
  
2. **`agent` = builtin sur disque.** On remplace la liste TS de `builtin-skills.ts` par une lecture de `skills/agent/`. On garde l'id `builtin:<name>` (pas de migration des `SkillSetting` / `BotSkill` existants). « Interrogate » devient `skills/agent/interrogate/SKILL.md`.
  
3. **Les deux familles sont montées dans le computer, une seule est branchée sur le coding agent.** Au démarrage, le supervisor copie `<repositoryRoot>/skills/{agent,computer}` → `DATA_DIR/managed-skills/{agent,computer}`, et `skillsBindsFor` ajoute un seul bind `/managed-skills:ro`. Dans le computer : `/managed-skills/agent` (Pi, via `shell`) et `/managed-skills/computer` (OpenCode). Pourquoi monter `agent` : `skill_read` ne renvoie que `SKILL.md`, et le tool `shell` de Pi s'exécute dans le computer, donc ses `scripts/` et `references/` doivent y être. Pi n'est pointé que vers `/managed-skills/agent`, OpenCode que vers `/managed-skills/computer`.
  
4. **OpenCode pinné dans l'image computer** via npm, comme Node. Les computer skills arrivent par un symlink dans `start.sh`.
  
5. **Docker uniquement en v1.** E2B / Daytona / Box : hors scope (voir section 5).
  
6. **Pas de nouveau modèle Prisma, pas d'UI nouvelle.** Les `agent` apparaissent dans la liste des skills comme les builtins aujourd'hui.
  

* * *
## 3. Implémentation
### PR 1 — Skills `agent` sur disque
- `skills/README.md` : documente la différence `agent` / `computer`. Ce fichier devient la seule source de cette définition ; la section 0 de ce plan n'est pas recopiée ailleurs. Lien depuis `AGENTS.md`.
- `skills/agent/interrogate/SKILL.md` : contenu actuel de `builtin-skills.ts`, via `buildSkillMd`.
  
- `builtin-skills.ts` → `loadBuiltinSkills()` (async), exporté par `@rakazo/adapters` : lit `<repoRoot>/skills/agent/*/SKILL.md` avec `parseSkillMd` (déjà dans `@rakazo/core`). ~15 lignes. `listUserSkills` (`skill-store.ts:55-93`) n'est pas réutilisable : il fige `id: user:…`, `source: "user"`, `readOnly: false`.
  
- Le nom du dossier doit être `skillDirName(name)` (`skill-store.ts:38`) ; sinon warning et skill ignorée. Comme ça, le chemin `/managed-skills/agent/<dir>/` se déduit du `name` que Pi voit, comme pour `/skills/user`. Garder le `name` exact du frontmatter (`Interrogate`) : l'id `builtin:Interrogate` en dépend.
  
- Root : `<repoRoot>/skills/agent` résolu via `import.meta.url`. Pas d'env, pas de cache : lire 2-3 dossiers par tour coûte rien (`// ponytail: no cache, add one if readdir shows in profiles`).
  
- Deux call-sites passent au loader : `skill-tools.ts:46` `builtinRecords()` (devient async) et `apps/api/src/agent-skills.ts:61-72` `builtinCatalog()` (devient async). Supprimer l'export `BUILTIN_AGENT_SKILLS` (`packages/adapters/src/index.ts:13`) pour qu'aucun appelant n'oublie la migration. Merge, shadow et visibilité ne changent pas.
  
- Injection : chaque skill `agent` arrive dans le catalogue du prompt (`executor.ts:3722`) avec son `name` et sa `description` issus du frontmatter, comme les skills user et marketplace. Pi choisit sur cette base et charge le corps avec `skill_read`. Le dossier `/managed-skills/agent` ne sert qu'à exécuter ou lire `scripts/` et `references/` via `shell`.
  
- Test : un `SKILL.md` invalide dans le dossier est ignoré avec un warning, sans casser le catalogue.
  
### PR 2 — Skills `agent` et `computer` montées dans le computer
- `infra/sandboxes/supervisor/Dockerfile` : `COPY skills skills`, sinon le supervisor de dev n'a aucune skill.
  
- Supervisor : `syncManagedSkills(repositoryRoot, dataDir)`, appelé dans `startSupervisor()` (`index.ts:814`) avant `serve`, jamais au top-level du module (les tests importent `index.js`). `repositoryRoot` est déjà calculé (`index.ts:91`). Pour `agent` puis `computer` :
  1. `rm -rf` des `.tmp-*` restés d'un crash précédent.
  2. Pour chaque `skills/<famille>/<slug>` : copie dans `DATA_DIR/managed-skills/<famille>/.tmp-<slug>`, `rm -rf <slug>`, puis `rename(.tmp-<slug>, <slug>)`. Le skill est absent quelques millisecondes : acceptable.
  3. Supprime les slugs qui ne sont plus dans le repo.
  
  Si le dossier source manque ou si une copie échoue : `logger.warn` et on continue. Jamais de `throw` ni de `process.exit` : un supervisor down bloque tous les computers.
  
  - On binde le parent `DATA_DIR/managed-skills`. Ni lui ni `agent/` / `computer/` ne sont jamais renommés. Seuls leurs enfants le sont, donc l'inode du dossier monté reste stable : les computers déjà lancés voient la nouvelle version sans être recréés. Remplacer le dossier entier figerait l'ancien inode dans les conteneurs.
    
- `skillsBindsFor` : ajouter `${translate(dataDir/managed-skills)}:/managed-skills:ro`.
- `executor.ts:3723` : ajouter au hint du prompt « builtin skills files under `/managed-skills/agent/<slug>/` (scripts/, references/) ».
- Tests :
  - `index.test.ts:263` : `skillsBindsFor` renvoie 3 binds.
  - `computer-loopback.test.ts` : nouveau cas, un conteneur existant dont les `Binds` n'ont pas `/managed-skills` est supprimé puis recréé (`index.ts:215`). Ce cas n'existe pas aujourd'hui.
  - `syncManagedSkills` : un `.tmp-x` laissé par un crash est nettoyé, un slug retiré du repo est supprimé, un dossier source absent ne fait pas échouer l'appel.
  
- **Non vérifié** : sur Docker Desktop macOS (virtiofs), qu'un computer déjà lancé voie bien les renames faits par le supervisor. Sur Linux c'est garanti. Au pire, sur macOS, recréer le computer.
  
### PR 3 — OpenCode + computer skills
- `infra/sandboxes/computer/Dockerfile` :
  
  ```dockerfile
  ARG OPENCODE_VERSION=<pin>
  RUN npm i -g opencode-ai@${OPENCODE_VERSION} && opencode --version
  ```
  
  Installé en global système (`/usr/local`), pas dans `NPM_CONFIG_PREFIX` du home.
  
- `start.sh`, après le seed de `.zshrc` :
  
  ```bash
  # Computer skills ship with the app image; OpenCode reads its global skills dir.
  mkdir -p "$AGENT_HOME/.config/opencode"
  [[ -e "$AGENT_HOME/.config/opencode/skills" || -L "$AGENT_HOME/.config/opencode/skills" ]] || ln -s /managed-skills/computer "$AGENT_HOME/.config/opencode/skills"
  ```
  
  Le `-L` évite de recréer le lien à chaque démarrage quand il est cassé (vieux supervisor, provider non Docker).
  
  **À vérifier sur la version pinnée** : que le scanner de skills d'OpenCode suit un symlink de dossier. Sinon, `~/.config/opencode/skills` devient un vrai dossier avec un symlink par `<slug>`. On reste sur `~/.config/opencode/skills` plutôt que `~/.claude/skills` : seul OpenCode doit lire `computer` en v1.
  
  - Le home est persistant : un user peut remplacer le symlink par un dossier à lui. C'est voulu, on ne l'écrase pas.
    
- **Credentials modèle** : v1, l'utilisateur fait `opencode auth login` dans le terminal du computer (login natif, Rakazo ne lit pas la clé). **Le token est persisté** dans `~/.local/share/opencode/auth.json`, donc dans le home persistant du computer (`computer-spec.ts:166-186`), donc dans `DATA_DIR` et dans `appdata.tgz` (`infra/compose/backup-prod.sh:45`). À faire dans cette PR : exclure `homes/*/.local/share/opencode` du `tar` de backup. Injection de la clé BYO du bot à l'exec = PR séparée, si demandé.
  
- **Comment Pi s'en sert** : skill `agent` `skills/agent/delegate-to-opencode/SKILL.md`. Il dit quand déléguer (tâche de code multi-fichiers dans un repo cloné), comment, et quoi faire après (lire `git diff`, lancer les tests, résumer). Aucun nouveau tool.
  
  `shell` coupe à 5 min, une tâche OpenCode dure souvent plus. Le skill lance donc en arrière-plan puis surveille :
  
  ```bash
  cd <repo> && nohup opencode run "<task>" > /tmp/opencode-<id>.log 2>&1 &
  ```
  
  puis `tail` du log et `kill -0 <pid>` à chaque tour jusqu'à la fin. Pas de `timeoutMs` géant : un shell bloqué 60 min bloque le tour de Pi.
  

* * *
## 4. Contenu initial
### `agent` (Pi)
| Skill | Rôle |
| --- | --- |
| `interrogate` | existant, migré |
| `delegate-to-opencode` | quand et comment déléguer du code à OpenCode, relecture du résultat. Visible par défaut partout (`skill-access.ts:42-44`), y compris pour les bots sans computer Docker : le skill commence par `command -v opencode` et s'arrête proprement si absent. |

Rester à 2-3 en v1 : chaque skill `agent` coûte une ligne de catalogue à chaque tour de chaque bot.
### `computer` (OpenCode)
| Skill | Rôle |
|---|---|
| `repo-onboard` | AGENTS.md / README, détecter le stack, install, lancer les tests |
| `pr-workflow` | branche, commits atomiques, `gh pr create`, suivi CI, fix |
| `tdd` | red → green → refactor |
| `systematic-debugging` | reproduire, isoler, cause racine, test de non-régression |
| `run-and-preview` | lancer le dev server, vérifier dans le Chromium du computer |

* * *
## 5. Hors scope / suites
- **E2B / Daytona / Box** : pas de mount. Suite naturelle : dans `prepare()`, pousser `skills/computer` avec `computer-workspace.ts` et installer OpenCode. À faire avec les templates dérivés du Dockerfile (déjà promis par `multi-harness.md:190`).
  
- **Fuite de visibilité préexistante** : `/skills/user` et `/skills/marketplaces` exposent tous les skills du user et du space, pas seulement ceux visibles par le bot. Non aggravée ici : les computer skills sont publiques par nature.
  
- **Computer skills visibles par Pi** : non en v1. Si besoin, ajouter `skills/computer` comme 2e root de `loadBuiltinSkills` avec `availability: selected` par défaut.
  
- **Tools** `code_agent_*` (OpenCode via `opencode serve`, calqué sur `cloud_agent_*` / Cursor) : seulement si le pattern shell + skill montre ses limites (suivi long, reprise).
  

* * *
## 6. Questions ouvertes
1. Le scanner de skills d'OpenCode suit-il un symlink de dossier, et ignore-t-il les dot-dirs, sur la version pinnée (voir PR 3) ?
  
2. Garder le nom de famille `builtin` dans l'UI, ou l'afficher « Agent » (cohérent avec le dossier) ? Les ids restent `builtin:` dans tous les cas.
