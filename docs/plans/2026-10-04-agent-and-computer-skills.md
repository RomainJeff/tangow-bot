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
  
- **L'image** `app` **contient tout le repo** : `COPY --chmod=755 . .` (`infra/compose/Dockerfile`). Un dossier `skills/` à la racine sera donc à `/app/skills/` dans le worker et le supervisor.
  
- **Les mounts skills** sont calculés par `skillsBindsFor(dataDir, spaceId, userId)` (`infra/sandboxes/supervisor/src/index.ts:156`). Ce sont des binds **depuis le host** (`translate` = `hostHomePath`). On ne peut pas binder un chemin de l'image `app` dans un conteneur frère : la source doit exister sur le host, donc sous `DATA_DIR`.
  
- **Le conteneur est recréé si les binds changent** (`index.ts:215`) : ajouter un bind migre les computers existants au prochain provision. Rien à faire.
  
- **L'image computer est buildée avec** `context: infra/sandboxes/computer` (`publish-server-image.yml:68`). Elle ne voit pas `skills/` à la racine. On passe donc par le mount, pas par un `COPY` (et c'est ce qu'on veut : MAJ des skills sans rebuild du computer).
  
- **OpenCode** n'est pas dans l'image. Node 22 + git + gh y sont déjà (commit d445ba11).
  

* * *
## 2. Decisions already made
1. **Source unique = le repo.** `skills/agent/` et `skills/computer/` à la racine, format `SKILL.md` standard (frontmatter `name`, `description`). Les deux familles peuvent avoir `scripts/` et `references/`.
  
2. **`agent` = builtin sur disque.** On remplace la liste TS de `builtin-skills.ts` par une lecture de `skills/agent/`. On garde l'id `builtin:<name>` (pas de migration des `SkillSetting` / `BotSkill` existants). « Interrogate » devient `skills/agent/interrogate/SKILL.md`.
  
3. **Les deux familles sont montées dans le computer, une seule est branchée sur le coding agent.** Au démarrage, le supervisor copie `/app/skills/{agent,computer}` → `DATA_DIR/managed-skills/{agent,computer}`, et `skillsBindsFor` ajoute un seul bind `/managed-skills:ro`. Dans le computer : `/managed-skills/agent` (Pi, via `shell`) et `/managed-skills/computer` (OpenCode). Pourquoi monter `agent` : `skill_read` ne renvoie que `SKILL.md`, et le tool `shell` de Pi s'exécute dans le computer, donc ses `scripts/` et `references/` doivent y être. Pi n'est pointé que vers `/managed-skills/agent`, OpenCode que vers `/managed-skills/computer`.
  
4. **OpenCode pinné dans l'image computer** via npm, comme Node. Les computer skills arrivent par un symlink dans `start.sh`.
  
5. **Docker uniquement en v1.** E2B / Daytona / Box : hors scope (voir section 5).
  
6. **Pas de nouveau modèle Prisma, pas d'UI nouvelle.** Les `agent` apparaissent dans la liste des skills comme les builtins aujourd'hui.
  

* * *
## 3. Implémentation
### PR 1 — Skills `agent` sur disque
- `skills/README.md` : documente la différence `agent` / `computer` (voir section 0, à recopier tel quel). Lien depuis `AGENTS.md`.
- `skills/agent/interrogate/SKILL.md` : contenu actuel de `builtin-skills.ts`, via `buildSkillMd`.
  
- `builtin-skills.ts` → `loadBuiltinSkills(root)` : lit `<root>/*/SKILL.md` avec `parseSkillMd` (déjà dans `@rakazo/core`). Réutiliser `listUserSkills` de `skill-store.ts` si sa signature le permet. Sinon, ~15 lignes.
  
- Root : env `RAKAZO_AGENT_SKILLS_DIR`, défaut `<repoRoot>/skills/agent`. Résolu une fois au boot, résultat mis en cache (`// ponytail: cache process-wide, reload on restart`).
  
- `skill-tools.ts:46` `builtinRecords()` consomme le loader. Rien d'autre ne change : merge, shadow, visibilité déjà en place.
  
- Test : un `SKILL.md` invalide dans le dossier est ignoré avec un warning, sans casser le catalogue.
  
### PR 2 — Skills `agent` et `computer` montées dans le computer
- Supervisor, au boot : `syncBundledSkills(appRoot, dataDir)`, pour `agent` puis `computer`. Pour chaque `skills/<famille>/<slug>`, copie dans `DATA_DIR/managed-skills/<famille>/.tmp-<slug>`, `rename` de l'ancien `<slug>` en `.old-<slug>`, `rename` de `.tmp-<slug>` en `<slug>`, puis `rm -rf .old-<slug>`. On passe par `.old-` parce que `rename` sur un dossier non vide échoue (`ENOTEMPTY`). Le skill est absent pendant quelques microsecondes : acceptable. Supprime les slugs qui ne sont plus dans le repo.
  
  - On binde le parent `DATA_DIR/managed-skills`. Ni lui ni `agent/` / `computer/` ne sont jamais renommés. Seuls leurs enfants le sont, donc l'inode du dossier monté reste stable : les computers déjà lancés voient la nouvelle version sans être recréés. Remplacer le dossier entier figerait l'ancien inode dans les conteneurs.
    
- `skillsBindsFor` : ajouter `${translate(dataDir/managed-skills)}:/managed-skills:ro`.
- `executor.ts:3723` : ajouter au hint du prompt « builtin skills files under `/managed-skills/agent/<slug>/` (scripts/, references/) ».
- Test : `skillsBindsFor` renvoie 3 binds ; le test existant sur la recréation pour changement de binds couvre la migration.
  
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
  [[ -e "$AGENT_HOME/.config/opencode/skills" ]] || ln -s /managed-skills/computer "$AGENT_HOME/.config/opencode/skills"
  ```
  
  **À vérifier sur la version pinnée** : le chemin exact du dossier global de skills d'OpenCode (`skills` ou `skill`) et sa compatibilité `~/.claude/skills`. Si OpenCode lit `~/.claude/skills`, on symlinke là, ce qui sert aussi au futur Claude Code (plan multi-harness).
  
  - Le home est persistant : un user peut remplacer le symlink par un dossier à lui. C'est voulu, on ne l'écrase pas.
    
- **Credentials modèle** : pas de token persisté dans le home. v1 : l'utilisateur fait `opencode auth login` dans le terminal du computer (même philosophie que le plan multi-harness : login natif, Rakazo ne voit rien). Injection de la clé BYO du bot à l'exec = PR séparée, si demandé.
  
- **Comment Pi s'en sert** : skill `agent` `skills/agent/delegate-to-opencode/SKILL.md`. Il dit quand déléguer (tâche de code multi-fichiers dans un repo cloné), comment (`shell` → `cd <repo> && opencode run "<task>"`), et quoi faire après (lire `git diff`, lancer les tests, résumer). Aucun nouveau tool.
  

* * *
## 4. Contenu initial
### `agent` (Pi)
| Skill | Rôle |
| --- | --- |
| `interrogate` | existant, migré |
| `delegate-to-opencode` | quand et comment déléguer du code à OpenCode, relecture du résultat |

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
1. Le chemin du dossier de skills global d'OpenCode sur la version pinnée (voir PR 3).
  
2. Garder le nom de famille `builtin` dans l'UI, ou l'afficher « Agent » (cohérent avec le dossier) ? Les ids restent `builtin:` dans tous les cas.
