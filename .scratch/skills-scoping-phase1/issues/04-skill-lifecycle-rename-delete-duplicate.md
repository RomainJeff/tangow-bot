# 04: Cycle de vie des accès — renommage, suppression, duplication de bot

**What to build:** Les lignes d'accès suivent la skill sur tout son cycle de vie. Renommer une skill (via l'outil `skill_update` ou l'API `agentSkills.update`) déplace ses lignes `SkillSetting`/`BotSkill` sur la nouvelle clé dans la même transaction que le renommage, donc une exclusion posée avant le rename tient après. Supprimer une skill (outil ou API) supprime ses lignes d'accès dans la même transaction (pas de lignes orphelines qui gêneraient un futur rename). Dupliquer un bot copie ses overrides `BotSkill` vers le nouveau bot, comme pour les serveurs MCP. Clôture : lier ce lot depuis le design doc Skills v2 (§ phasage) avec le hash livré et noter la simplification « pas de section Skills séparée dans BotSettings ».

**Blocked by:** 01 (modèle de visibilité via RPC)

**Status:** ready-for-agent

- [ ] Rename via outil : lignes d'accès sur nouvelle clé, plus rien sur l'ancienne ; rename sans changement de clé (casse seule) ne touche rien
- [ ] Rename via API : idem
- [ ] Delete via outil et via API : lignes d'accès supprimées
- [ ] `bots.duplicate` copie les overrides du bot source vers le duplicata
- [ ] Tests adapters : rename conserve l'exclusion, delete nettoie tout
- [ ] E2E : exclure Chief, renommer par RPC, `list({botId: chief})` toujours sans la skill, re-renommer
- [ ] Design doc mis à jour, `pnpm lint && pnpm check && pnpm test` verts, push sur `romainjeff` uniquement
