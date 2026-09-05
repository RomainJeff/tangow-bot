# 03: Le panneau Skills lit et écrit les fichiers via l'API

**What to build:** `agentSkills.list/get/create/update/remove/setAccess` servent les fichiers du store (ticket 01). L'id public d'une skill user devient `user:<lower(name)>` (le contrat `Id` l'accepte tel quel, aucun changement de schéma oRPC ni de client web/mobile). Créer, ouvrir, éditer, renommer, supprimer et régler l'accès d'une skill depuis le panneau fonctionne exactement comme aujourd'hui, avec le contenu sur disque. Un rename change l'id ; le panneau rafraîchit la liste après save, donc rien à changer côté web. Le test-run de routine reçoit les skills du bot depuis les fichiers.

Erreurs : doublon de nom (fichiers + builtins) → `CONFLICT` ; id inconnu ou `builtin:` en update/remove → `IsolationError` comme avant. Le code mort (`P2002`, `readOnly` sur rows) disparaît. Même ordre rename/delete que le ticket 02.

**Blocked by:** 01 (store filesystem)

**Status:** ready-for-agent

- [ ] `createAgentSkillsService` reçoit `dataDir` (branché dans le router) et n'utilise plus `prisma.agentSkill`
- [ ] `create` retourne une entrée avec `id = user:<name>`, `readOnly:false`, dates ISO ; doublon → `CONFLICT`
- [ ] `update` avec nouveau nom : nouvel id, rows `SkillSetting`/`BotSkill` suivent la clé, ancien dossier supprimé ; même nom → remplacement en place
- [ ] `remove` : fichier puis rows d'accès purgées
- [ ] `list`/`list({botId})`/`setAccess` : availability + visibleBotIds inchangés en comportement
- [ ] Test unitaire API (mocks in-memory pour les rows, tmpdir pour les fichiers) : create → setAccess → rename cascade → remove GC ; conflit ; isolation
- [ ] E2E `skill-access`, `slash-skills`, `knowledge-panel` verts **sans modification**
