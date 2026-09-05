# 02: Chips agents et toggle « All agents » dans le panneau Skills

**What to build:** Dans Knowledge > Skills d'un bot, chaque skill éditable affiche une rangée : un bouton « All agents » (état = availability) et un chip par bot non archivé (état = présence dans `visibleBotIds`, calculé côté serveur). Cliquer « All agents » bascule `all`/`selected` ; cliquer un chip écrit l'override du bot (exclusion sous `all`, inclusion sous `selected`). Après clic, la ligne se met à jour avec l'entrée renvoyée par `setAccess`. Les skills read-only (builtins/plugins) n'ont pas de chips. Le bot courant est un chip comme les autres (pas de section « Skills » séparée dans BotSettings : KnowledgeSection y est déjà rendue).

Pattern UI : mêmes chips que l'affectation des serveurs MCP (bouton arrondi `xs`, variante pleine + icône check si actif, `aria-pressed`). Une ligne de skill = conteneur + bouton nom/description à l'intérieur (pas de boutons imbriqués). Textes passés par lingui.

**Blocked by:** 01 (modèle de visibilité via RPC)

**Status:** ready-for-agent

- [ ] Rangée « All agents » + chips bots visible sous chaque skill éditable, absente sous les read-only
- [ ] Clic chip → override écrit → état visuel reflète `visibleBotIds` renvoyé ; rechargement conserve l'état
- [ ] Clic « All agents » bascule availability ; chips reflètent le nouveau calcul
- [ ] Erreur RPC → message d'erreur dans le panneau, pas de crash
- [ ] Ouvrir la skill (clic nom) fonctionne toujours ; supprimer/éditer inchangés
- [ ] E2E knowledge-panel : chip Chief pressé → décoché ; `list({botId: chief})` sans la skill ; picker Chief sans la skill ; re-cocher avant suppression
- [ ] Catalogues lingui extraits, `pnpm lint`/`check`/`test` web verts
