# `skill_read` renvoie le dossier du skill dans le computer — Plan
> **For Claude:** contrat d'implémentation. Les décisions de la section 2 ne se rouvrent pas dans la PR.

**Goal :** Pi connaît le chemin exact des fichiers d'un skill (`scripts/`, `references/`) dans le computer, au lieu de le reconstruire depuis la phrase d'indication du prompt. Une seule PR.

* * *
## 1. Le problème

Le catalogue du prompt ne donne que `- Nom: description` (`packages/core/src/agent-skill.ts:120`). Les chemins arrivent par une phrase fixe (`packages/adapters/src/executor.ts:3725`) qui liste trois racines avec des trous à remplir :

| Source | Chemin dans le computer | Ce que Pi doit deviner |
|---|---|---|
| builtin (`agent`) | `/managed-skills/agent/<slug>/` | `slug = skillDirName(name)`, imposé par `loadBuiltinSkills` : devinable |
| user | `/skills/user/<skill-dir>/` | `skillDirName(name)` = nom en minuscules URL-encodé (`Daily standup` → `daily%20standup`). La règle n'est pas dans le prompt |
| marketplace | `/skills/marketplaces/<mkt>/plugins/<plugin>/skills/<slug>/` | `<mkt>` et `<plugin>` ne sont exposés nulle part : Pi doit faire un `find` |

`skill_read` (`packages/adapters/src/skill-tools.ts:139`) renvoie `name`, `description`, `source`, `readOnly`, `content`, sans chemin. Les skills forcés (`/Name`) ou mentionnés (`@Name`) sont développés dans le prompt par `expandSkillReferencesInPrompt` sans passer par `skill_read` : ils n'ont pas de chemin non plus.

* * *
## 2. Décisions

1. **Le chemin se déduit de l'id, pas d'un nouveau stockage.** Les trois formes d'id portent déjà tout :
   - `builtin:<name>` → `/managed-skills/agent/${skillDirName(name)}`
   - `user:<key>` → `/skills/user/${skillDirName(name)}`
   - `mkt:<mkt>/<plugin>/<slug>` → `/skills/marketplaces/<mkt>/plugins/<plugin>/skills/<slug>` (segments validés par `SAFE_NAME` à l'install)
   
   Une fonction pure `sandboxSkillDir(record)` dans `@rakazo/adapters` (`skill-tools.ts`, à côté de `skillDirName`). Pas de champ en base, pas de champ ajouté à `SkillRecord`.

2. **Les points de montage ont une seule source.** Constantes `SANDBOX_SKILL_MOUNTS = { user: "/skills/user", marketplaces: "/skills/marketplaces", managed: "/managed-skills" }` dans `@rakazo/core` (déjà dépendance du supervisor). `skillsBindsFor` (`infra/sandboxes/supervisor/src/index.ts:157`) et `sandboxSkillDir` les utilisent ; plus aucun littéral de chemin de montage ailleurs.

3. **`skill_read` ajoute un champ `dir`.** Nom court, absolu, sans slash final. Pas de `files` listés : Pi fait `ls` s'il en a besoin, et la plupart des skills n'ont que `SKILL.md`.

4. **La phrase d'indication du prompt raccourcit.** Elle devient : `Skill files (scripts/, references/) are mounted read-only in the sandbox; skill_read returns the skill's folder as dir.` Les trois gabarits de chemin disparaissent. Une ligne de moins par tour pour chaque bot.

5. **Les skills développés dans le prompt portent aussi leur dossier.** `formatForcedSkillPrompt` et le bloc `@Name` ajoutent une ligne `Files: <dir>` sous `Use skill: <name>`. `expandSkillReferencesInPrompt` reste dans `@rakazo/core` et reçoit le résolveur en paramètre optionnel (`dirFor?: (skill) => string`) pour ne pas tirer `skillDirName` des adapters dans core ; sans résolveur, comportement actuel.
   
   L'idempotence (`restAlreadyIncludesSkillContent`) ne change pas : la ligne `Files:` est hors du contenu comparé.

6. **Le chemin est renvoyé même quand le computer n'a pas les montages** (E2B, Daytona, Box). C'est déjà ce que promet la phrase d'indication aujourd'hui ; la rendre conditionnelle au provider est hors scope (voir section 5).

* * *
## 3. Implémentation

- `packages/core/src/skill-access.ts` (ou un nouveau `sandbox-skills.ts` exporté par l'index) : `SANDBOX_SKILL_MOUNTS`.
- `infra/sandboxes/supervisor/src/index.ts` : `skillsBindsFor` utilise les constantes. Sortie identique : le test existant (`index.test.ts`, 3 binds) passe sans modification, ce qui prouve qu'aucun computer ne sera recréé (`index.ts:215` compare les binds).
- `packages/adapters/src/skill-tools.ts` :
  - `export function sandboxSkillDir(record: { id: string; name: string }): string`. Pour `mkt:`, découper l'id ; un id malformé lève (bug, pas entrée utilisateur).
  - `skillReadFromTool` ajoute `dir: sandboxSkillDir(skill)`.
- `packages/adapters/src/executor.ts` :
  - `:3725` : nouvelle phrase (décision 4).
  - `:1083` et `:3731` : passer `sandboxSkillDir` à `expandSkillReferencesInPrompt`.
- `packages/adapters/src/builtin-tools.ts:709`, description du tool `skill_read` : mentionner `dir` en quelques mots.
- `packages/core/src/agent-skill.ts` : paramètre `dirFor` dans `expandSkillReferencesInPrompt` et `formatForcedSkillPrompt`.

Rien côté web, mobile ou desktop : le champ n'est consommé que par Pi.

* * *
## 4. Tests

- `skill-tools.test.ts` :
  - `skill_read` d'un skill user nommé `Daily standup` → `dir: "/skills/user/daily%20standup"`.
  - `skill_read` d'un skill marketplace installé en fixture → `dir` = `/skills/marketplaces/<mkt>/plugins/<plugin>/skills/<slug>`.
  - `skill_read` d'un builtin (`Interrogate`) → `/managed-skills/agent/interrogate`.
  - Le dossier renvoyé correspond au dossier réel : pour chaque source, `path.join(dataDir, …)` reconstruit depuis `dir` en remplaçant le point de montage par la source de `skillsBindsFor` contient bien `SKILL.md`. C'est le test qui empêche le chemin et le montage de diverger.
- `agent-skill.test.ts` : `/Name` et `@Name` avec résolveur → la ligne `Files:` est présente ; sans résolveur → sortie inchangée ; double expansion toujours idempotente.
- `index.test.ts` (supervisor) : inchangé, doit passer tel quel.

* * *
## 5. Hors scope

- **Ne renvoyer `dir` que si le computer a les montages.** Demande de connaître le provider du computer dans `skill_read`. À faire avec le portage des skills vers E2B / Daytona / Box (`2026-10-04-agent-and-computer-skills.md`, section 5).
- **Écart worker / computer pour les builtins.** `skill_read` lit `/app/skills/agent` (image `app` du worker), le computer voit la copie du supervisor dans `DATA_DIR/managed-skills`. Si les deux images ne sont pas à la même version, le `SKILL.md` et les `scripts/` peuvent diverger. Inchangé ici ; à noter si un bug le montre.
- **Fuite de visibilité** de `/skills/user` et `/skills/marketplaces` : préexistante, déjà notée dans le plan managed skills.

* * *
## 6. CHANGELOG

`#### Fixed` : « Bots now find the scripts and reference files of your skills and marketplace skills on their computer without searching for them. »
