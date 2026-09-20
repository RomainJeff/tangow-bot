# 09: Décision — borner le nombre d'outils de connecteurs exposés

**What to build:** Une décision, pas du code. Question d'origine : pose-t-on un plafond sur les outils de connecteurs exposés au modèle, ou laisse-t-on ouvert ?

## Ce que le cadrage a corrigé

**Le plafond existe déjà.** L'audit a raté `packages/adapters/src/lazy-tool-catalog.ts`, livré le 2026-08-31 (`89f45ccf`, « feat(adapters): lazily load large tool schemas (#429) »), trois semaines avant la rédaction des tickets. `DIRECT_TOOL_LIMIT = 20` : au-delà, la liste s'effondre en trois outils enveloppes — `search_tools`, `load_tool`, `execute_tool` — avec un index de noms embarqué dans la description tant qu'il tient dans `NAME_INDEX_MAX_BYTES = 2 048`.

**Mais il n'est appliqué que par deux providers sur quatre.**

| Provider | Plafond | Référence |
|---|---|---|
| MCP | oui, 20 puis catalogue paresseux | `mcp-connector.ts:94` |
| Installed / API | oui, 20 puis catalogue paresseux | `installed-connectors.ts:116` |
| Composio | **aucun** — `asConnectorTools(raw)` rendu tel quel | `composio-connector.ts:365` |
| Pipedream | **aucun** — 20 apps max, mais `groups.flat()` sans borne sur les outils | `pipedream-connector.ts:153` |

**Et aucun plafond global après fusion.** `ConnectorRegistry.discoverTools` (`composio-connector.ts:612`) concatène les providers sans re-borner. Un bot avec MCP et Installed actifs expose jusqu'à 40 outils directs, plus tout ce que Composio et Pipedream ajoutent.

**D'autres bornes existent ailleurs, sur d'autres axes.** `MAX_MCP_TOOLS = 250` et `MAX_MCP_PAGES = 20` bornent la pagination `listTools` (`remote-mcp.ts:19-20`, appliqués `:49` et `:55`), et `graphql-connectors.ts:260` a ses propres plafonds de queries et mutations. Aucune ne protège la fenêtre de contexte : elles bornent ce qu'on récupère, pas ce qu'on expose. À ne pas confondre avec le plafond décisionnel.

**Le plafond porte sur un nombre, pas sur un coût.** Vingt schémas gras coûtent plus que deux cents maigres — `SELECTED_SCHEMA_MAX_BYTES = 100 000` dit que les schémas peuvent être énormes. Un bot à dix-neuf outils MCP verbeux passe sous le plafond et gonfle chaque run. C'est `toolSchemaTokens`, logué au ticket 01 à côté de `toolCount`, qui mesure le vrai coût ; `toolCount` seul ne le voit pas.

**Le non-objectif est faux et doit être corrigé.** `NON-GOALS.md` écarte « recherche d'outils à la demande au-delà de N outils » au motif que l'aller-retour coûterait plus qu'il n'économise. Le code fait exactement cela depuis trois semaines. Le non-objectif doit être réécrit pour décrire ce qui est réellement écarté, sinon quelqu'un supprimera le catalogue paresseux en s'appuyant dessus.

## La question reformulée

Trois questions distinctes, dont deux ne sont plus des décisions mais des correctifs :

1. **Composio et Pipedream échappent au plafond.** Bug d'uniformité, pas arbitrage. Ticket de correctif si les chiffres montrent que ces providers produisent des catalogues larges.
2. **Aucune borne globale après fusion.** À trancher : borner la liste fusionnée, ou accepter la somme des plafonds par provider.
3. **`DIRECT_TOOL_LIMIT = 20` est-il la bonne valeur, et sur le bon axe ?** À trancher sur `toolSchemaTokens`, pas sur `toolCount`.

Le plafond a par ailleurs une falaise : vingt outils passent en direct, vingt et un s'effondrent en trois enveloppes. Rien entre les deux. Si les chiffres montrent des bots juste sous la limite avec des schémas lourds, c'est la falaise qu'il faut lisser, pas la valeur qu'il faut baisser.

Le plafond sur la liste fusionnée pose un effet de bord : basculer en catalogue paresseux masque des outils de tous les providers d'un coup, y compris ceux d'un connecteur qui n'a que deux outils. Toute décision de borner globalement doit dire ce que le modèle lit à la place.

## Critère de décision

Écrire les seuils **avant** de regarder les chiffres.

- p99 de `toolSchemaTokens` sous 5 % de la `contextWindow` médiane → statu quo, corriger seulement l'uniformité Composio/Pipedream
- p99 au-dessus de 15 % → borner, et borner en tokens plutôt qu'en nombre
- `toolCount` p99 nettement au-dessus de 40 → un provider non plafonné domine ; le correctif d'uniformité suffit probablement, remesurer après

Hors périmètre : supprimer le catalogue paresseux, ou ajouter un second mécanisme de découverte à côté.

**Blocked by:** Rien. Le ticket 01 est mergé (`cb407626`).

**Status:** needs-decision

- [ ] `NON-GOALS.md` corrigé : le catalogue paresseux existe, décrire ce qui est réellement écarté
- [ ] Destination des logs vérifiée : `AXIOM_TOKEN` / `AXIOM_DATASET` sont optionnels (`infra/compose/docker-compose.prod.yml:215`). Sans Axiom configuré, aucun agrégat n'existe
- [ ] Distribution de `toolSchemaTokens` et `toolCount` par run relevée sur au moins sept jours, p50 / p95 / p99, croisée avec `contextWindow`
- [ ] Croisement avec les providers actifs par bot, pour savoir si la queue vient de Composio ou Pipedream
- [ ] Part des runs où le catalogue paresseux s'est déclenché, et part des runs entre quinze et vingt outils directs — les deux côtés de la falaise
- [ ] Seuils écrits avant lecture des chiffres
- [ ] Décision tranchée et consignée : plafond global ou statu quo
- [ ] Ticket d'uniformité créé si Composio ou Pipedream produisent des catalogues larges
- [ ] Si plafond : valeur et axe (tokens ou nombre) choisis sur la base des chiffres, pas d'un seuil de référence externe, et comportement du modèle face aux outils masqués explicité
