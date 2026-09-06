# 04: Skills marketplace dans le catalogue, l'accès et les tools

**What to build:** Les skills installés depuis une marketplace apparaissent partout où les skills user apparaissent : `agentSkills.list` (catalogue avec `availability: selected` par défaut, donc visibles à aucun bot tant que l'utilisateur ne les active pas), `agentSkills.get`, `agentSkills.setAccess` (par utilisateur, comme pour les skills user), la liste des records utilisée par l'executor pour le prompt et le slash picker, et le tool `skill_read`. `agentSkills.update/remove` et les tools `skill_update/skill_delete` refusent les `mkt:` (read-only, message explicite). Le prompt indique où les fichiers sont montés (`/skills/user/...`, `/skills/marketplaces/...`).

**Décisions :** l'index d'accès est désormais clé par identifiant de skill (`user:` / `mkt:`) et non par nom ; défaut d'availability via `defaultSkillAvailability`. Cap 50 du catalogue inchangé.

**Blocked by:** 02 (store + helpers core)

**Status:** done

- [x] Tests adapters : skill `mkt:` absent des records sans setting, présent avec `BotSkill.enabled`, `source: plugin` + `readOnly`, tools update/delete refusés
- [x] Tests API : catalogue expose `mkt:` avec `selected` / `visibleBotIds: []`, setAccess active un bot, get renvoie le contenu, update/remove refusés, autre space → not found
- [x] Indice de chemins montés ajouté au prompt ; check + tests verts
