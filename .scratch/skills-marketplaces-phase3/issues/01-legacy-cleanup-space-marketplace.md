# 01: Nettoyage legacy + table SpaceMarketplace

**What to build:** Le schéma est prêt pour les marketplaces et le legacy phase 1/2 disparaît. La table `agent_skills` est supprimée (son export FS au boot API aussi), les orphelins `skills-lock.json` et `.agents/skills/composio/` sont retirés du repo, et une nouvelle table `SpaceMarketplace` (Space-level, `@@unique([spaceId, name])`, url / ref / commit épinglé / installedPlugins JSON) existe avec sa migration SQL manuelle.

**Décisions :** pas de lock file, la ligne DB est le lock (design Q3). Migration dans le style des précédentes (TEXT ids, TIMESTAMP(3), FK ON DELETE CASCADE).

**Blocked by:** None (can start immediately)

**Status:** done

- [x] `agent_skills` droppée par migration ; modèle Prisma `AgentSkill` et toute relation supprimés ; `prisma validate` passe
- [x] Export legacy au boot API supprimé (module + test + appel), `@rakazo/api` check + tests verts
- [x] `skills-lock.json` et `.agents/skills/composio/` supprimés
- [x] Modèle + migration `SpaceMarketplace` créés, relation `marketplaces` sur `Space`
