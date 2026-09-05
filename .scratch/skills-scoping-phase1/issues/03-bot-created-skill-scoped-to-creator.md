# 03: Une skill créée par un agent est visible par cet agent seul

**What to build:** Quand un bot appelle l'outil `skill_create` pendant un run, la skill est créée avec `availability = selected` et un override `enabled = true` pour le bot créateur, dans la même transaction que la création. Les autres bots ne la voient pas (catalogue, `/Nom`, `skill_read`) tant que l'utilisateur ne l'a pas partagée depuis le panneau (ticket 02). Une skill créée à la main dans le panneau ou via l'API reste « tous les agents » (aucune ligne créée). Le hint renvoyé au bot et la description de l'outil disent que la skill est visible par cet agent et que l'utilisateur peut la partager ; la phrase fausse sur « le runtime Pi comprend ce format » disparaît de la description.

Décision : design doc Skills v2, Q2 = `selected`.

**Blocked by:** 01 (modèle de visibilité via RPC)

**Status:** ready-for-agent

- [ ] `skill_create` avec bot connu → `SkillSetting.selected` + `BotSkill[créateur].enabled=true`, atomique
- [ ] Sans bot (création API/panneau) → aucune ligne d'accès, skill visible partout
- [ ] Test adapters : créateur voit la skill, autre bot non, liste sans bot la contient
- [ ] Hint de `skill_create` et description de l'outil mis à jour
- [ ] Panneau (ticket 02) montre la skill avec « All agents » off et seul le chip créateur actif
