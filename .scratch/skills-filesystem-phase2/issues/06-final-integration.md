# 06: Intégration finale phase 2

**What to build:** Tout le runtime et l'API tournent sur les fichiers, l'export legacy est en place, l'éditeur valide. Vérification globale sur `main` : suites core/adapters/api/web, `pnpm check`, e2e `skill-access` + `slash-skills` + `knowledge-panel`. Le seul accès restant à `prisma.agentSkill` est l'export au boot. Le design doc Skills v2 note la livraison de la phase 2 sur la ligne du tableau des phases (`Livré : merge <sha> (2026-09-05)`), avec la mention « cache mtime non fait (YAGNI) ; drop `agent_skills` → phase 3 ». Rien n'est poussé sans demande explicite de Romain (`git push romainjeff main` uniquement, jamais `origin`).

**Blocked by:** 02 (tools sur FS), 03 (API sur FS), 04 (export + purge), 05 (validation éditeur)

**Status:** ready-for-agent

- [ ] Suites unitaires core, adapters, api, web vertes ; `pnpm check` vert
- [ ] E2E `skill-access`, `slash-skills`, `knowledge-panel` verts
- [ ] `grep agentSkill\.` hors tests/generated ne renvoie que l'export legacy
- [ ] Schéma Prisma : modèle `AgentSkill` toujours présent (drop phase 3)
- [ ] Ligne phase 2 du design doc mise à jour, commit docs
- [ ] `docs/plans/2026-09-05-channels.md` non touché
