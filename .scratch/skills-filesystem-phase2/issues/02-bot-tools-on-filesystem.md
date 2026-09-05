# 02: Les agents lisent et écrivent leurs skills en SKILL.md

**What to build:** Pendant un run, le catalogue de skills injecté dans le prompt, l'expansion `/Nom`, `skill_read`, `skill_create`, `skill_update`, `skill_delete`, ainsi que le chargement des skills pour les routines, viennent des fichiers du store (ticket 01) et plus de la table `agent_skills`. Les règles phase 1 restent : skill créée par un bot = `selected` + override créateur (même transaction sur les rows d'accès), filtrage par visibilité du bot, rename qui suit la clé sur `SkillSetting`/`BotSkill`. Le worker et l'API partagent le même volume `/data`, donc un fichier écrit par un bot est visible partout. L'id renvoyé au bot devient la skillKey.

Ordre imposé : rename = écrire le nouveau dossier (`create`), cascader les rows, supprimer l'ancien ; delete = fichier d'abord, rows ensuite (rows orphelines tolérées ; l'inverse élargirait la visibilité à « tous »). Executor : `dataDir` par défaut `./data`, aligné sur l'env API et le worker.

**Blocked by:** 01 (store filesystem)

**Status:** ready-for-agent

- [ ] Plus aucun accès `prisma.agentSkill` dans le runtime adapters (tools, executor, routines)
- [ ] `skill_create` : doublon (case-insensitive, builtins inclus) → erreur « already exists » ; bot connu → rows `selected` + créateur `enabled`
- [ ] `skill_update` : rename cascade rows puis supprime l'ancien dossier ; même nom → remplacement atomique ; builtins refusés
- [ ] `skill_delete` : fichier puis rows ; rows d'accès dont le fichier a disparu n'apparaissent nulle part
- [ ] Catalogue/`/Nom`/routines filtrés par bot comme en phase 1 (tests adapters adaptés : seed via fichiers dans un tmpdir, plus de mock `agentSkill`)
- [ ] Test « expands @skill mentions in the routine prompt at fire time » passe avec un SKILL.md sur disque
- [ ] Suite adapters, `check`, biome verts
