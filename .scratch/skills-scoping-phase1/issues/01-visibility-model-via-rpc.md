# 01: Modèle de visibilité des skills par bot, piloté par RPC

**What to build:** Une skill peut être « pour tous les agents » ou « pour une sélection d'agents », avec un override par bot. Un bot ne voit que ses skills visibles : catalogue injecté dans le prompt, expansion `/Nom` dans les messages, `skill_read`, routines et test-run de routine. Le slash picker du composer ne propose que les skills visibles du bot actif. Tout se pilote par RPC (`agentSkills.list({botId?})` renvoie `availability` + `visibleBotIds` ; `agentSkills.setAccess` écrit le toggle global et/ou l'override d'un bot). Pas d'UI dans ce ticket.

Règles (design doc Skills v2 §2, Q3) :
- `skillKey = "user:" + lower(name)` — même règle que l'index unique case-insensitive existant.
- `visible = override(bot) ?? (availability === "all")`. Absence de ligne = `all` → les skills existantes gardent le comportement actuel sans migration de données.
- Builtins : toujours visibles, `availability: "all"`, `visibleBotIds` = tous les bots non archivés.
- Cap 50 du catalogue inchangé, compte seulement les skills visibles.
- Tables : `SkillSetting {spaceId, userId, skillKey, availability}` unique sur (space, user, key) ; `BotSkill {spaceId, userId, botId, skillKey, enabled}` unique sur (bot, key), cascade sur suppression du bot. Migration SQL écrite à la main, `prisma migrate diff` sans différence.
- Isolation (space, user) partout ; `setAccess` vérifie que skill et bot appartiennent à l'acteur ; builtins et skills read-only refusés.

Prefactoring inclus : helper pur dans `@rakazo/core` (clé + visibilité) testé unitairement, réutilisé par runtime et API.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Helper pur (clé, visibilité, coercion availability) avec tests unitaires
- [ ] Migration SQL appliquée, `prisma migrate diff --exit-code` propre, `pnpm check` vert
- [ ] `agentSkills.list()` renvoie `availability` + `visibleBotIds` pour chaque skill ; `list({botId})` ne renvoie que les visibles
- [ ] `agentSkills.setAccess` : toggle `all|selected`, override `{botId, enabled}`, refus hors isolation, retourne l'entrée mise à jour
- [ ] Runtime : catalogue prompt, expansion `/Nom`, `skill_read`, routines et test-run de routine filtrés par bot (test adapters : 2 bots, 3 skills, résultats différents)
- [ ] Slash picker filtré sur le bot actif ; en groupe, liste complète (comportement actuel)
- [ ] E2E via RPC : `setAccess` exclut Chief → `list({botId: chief})` et picker sans la skill, `list()` la contient toujours
- [ ] `slash-skills` e2e existant toujours vert
