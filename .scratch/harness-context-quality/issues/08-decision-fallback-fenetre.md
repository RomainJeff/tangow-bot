# 08: Décision — simplifier le fallback de fenêtre en nombre de messages

**What to build:** Une décision, pas du code. `historyWindowSize()` (`packages/adapters/src/history-compaction.ts:98`) choisit entre deux tailles de fenêtre — `HISTORY_WINDOW_SIZE = 50` et `LEGACY_HISTORY_WINDOW_SIZE = 200` — selon une condition triple : mémoire sémantique activée, thread compacté, rappel réussi. Cette taille n'est utilisée que quand `selectHistoryWindow` retombe en mode `count`.

Question à trancher : garde-t-on la condition triple, ou la supprime-t-on au profit d'une seule taille de fallback ?

## Ce que le cadrage a corrigé

**Le fallback ne concerne pas que les modèles hors catalogue.** `selectHistoryWindow` renvoie `mode: "count"` depuis deux endroits :

| Site | Cause | Concerné par le ticket 03 |
|---|---|---|
| `history-compaction.ts:174` | `contextWindow` inconnue | oui — se raréfie depuis 03 |
| `history-compaction.ts:197` | budget plus petit que le dernier échange, aucun message dans le budget n'ouvre un tour | **non** — se déclenche aussi sur les modèles catalogués |

Le second chemin survit au ticket 03 : sur un thread à longs échanges, un modèle parfaitement catalogué y tombe. C'est là que l'écart 50 vs 200 coûte le plus cher — un facteur 4 sur une fenêtre déjà jugée trop petite pour le budget.

**Un troisième cas échappe entièrement à la fenêtre.** Quand `compactedHistory.usedLocalSummary` est vrai, `executor.ts:3740` saute `selectHistoryWindow` : ni budget tokens, ni taille de fallback, ni condition triple. À compter séparément, sinon il gonfle artificiellement la part « ni tokens ni count ».

**La mesure est déjà disponible, sans code supplémentaire.** La ligne `agent.run.context` livrée au ticket 01 porte `historyWindowMode` *et* `contextWindow`. Le croisement des deux sépare les causes :

- `mode="count"` et `contextWindow` absente ou nulle → chemin hors catalogue
- `mode="count"` et `contextWindow > 0` → chemin dépassement de budget
- pas de ligne `agent.run.context` avec un `historyWindowMode` → résumé local, fenêtre non appliquée

**La branche `LEGACY_HISTORY_WINDOW_SIZE` ne coupe rien.** L'historique est chargé avec `take: LEGACY_HISTORY_WINDOW_SIZE` (`executor.ts:1252` → `packages/db/src/messages.ts:27`), soit deux cents messages au maximum. Le `slice(-200)` de la branche « legacy » porte donc sur une liste qui n'a jamais plus de deux cents entrées : c'est un no-op. La condition triple ne choisit pas entre deux tailles, elle choisit entre **couper à cinquante** et **ne pas couper**. Tout le cadrage de la décision en dépend, et le ticket d'origine ne le disait pas.

**Le chemin dépassement de budget est rare par construction.** Le budget est planchonné : `Math.max(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, ...)` avec `keepRecentTokens = 20 000` (défauts pi, `history-compaction.ts:176-181`). Le site `:197` ne se déclenche donc que si le dernier échange à lui seul dépasse vingt mille tokens. À vérifier dans les chiffres avant d'en faire un argument.

**Si simplifier : les constantes ne disparaissent pas.** Seule la fonction `historyWindowSize()` et sa condition triple partent. `LEGACY_HISTORY_WINDOW_SIZE` reste utilisée en `history-compaction.ts:389` (borne du `take` Prisma) et `HISTORY_WINDOW_SIZE` en `history-compaction.ts:646` (ordonnancement de la compaction). Le diff est l'appelant `executor.ts:3745` plus les tests de `historyWindowSize`.

**Choisir la valeur unique est la vraie décision, pas la suppression.** Supprimer la condition impose de retenir 50 ou 200. Sur le chemin dépassement de budget, 200 messages dans une fenêtre déjà saturée est exactement ce que le ticket 04 cherchait à éviter ; 50 sur un thread non compacté sans mémoire sémantique perd de l'historique que rien ne rattrape.

## Critère de décision

Écrire le seuil **avant** de regarder les chiffres, sinon la décision se justifie après coup.

- Part des runs en `mode="count"` sous 2 %, tous chemins confondus → simplifier, valeur unique `HISTORY_WINDOW_SIZE`
- Chemin dépassement de budget au-dessus de 5 % des runs → ne pas toucher à la condition ; ouvrir un ticket sur le dimensionnement du budget, qui est le vrai problème
- Entre les deux → garder en l'état et reconduire la mesure après un mois

Un contrôle sépare les deux lectures : sur les runs en `mode="count"`, comparer `historyMessagesKept` à `historyMessagesAvailable`. Égaux → branche legacy, rien n'a été coupé. `kept = 50` → branche `HISTORY_WINDOW_SIZE`. C'est la seule façon de savoir laquelle des deux branches sert réellement, le mode logué ne les distingue pas.

**Blocked by:** Rien. Le ticket 03 est mergé (`6c114898`), le ticket 01 aussi (`cb407626`).

**Status:** needs-decision

- [ ] Destination des logs vérifiée : `AXIOM_TOKEN` / `AXIOM_DATASET` sont optionnels (`infra/compose/docker-compose.prod.yml:215`). Sans Axiom configuré, aucun agrégat n'existe — soit l'activer, soit collecter depuis les logs conteneur sur une fenêtre datée
- [ ] Part des runs par mode relevée sur au moins sept jours, avec les trois cas séparés : hors catalogue, dépassement de budget, résumé local
- [ ] Critère de décision écrit avant lecture des chiffres
- [ ] Décision tranchée et consignée : simplifier (et avec quelle valeur) ou garder
- [ ] Si simplifier : ticket de suppression créé — `historyWindowSize()` et son appelant `executor.ts:3745`, tests compris, constantes conservées
