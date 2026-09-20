# 12: Décision — qui possède le run de compaction d'un thread de groupe

**What to build:** Une décision, pas du code. `compactHistory` sort immédiatement quand le thread n'a pas de bot propriétaire (`packages/adapters/src/history-compaction.ts:357`, `if (!thread.botId) return;`). Les threads de groupe sont créés avec `groupId` et sans `botId` (`packages/db/src/groups.ts:275`) : les deux conditions sont exclusives, **aucun thread de groupe n'est jamais compacté**.

Question à trancher : lève-t-on la garde, et si oui **quel bot membre possède le run de résumé** — son modèle, sa credential et son conteneur de mémoire résumant une conversation partagée par tous les membres ?

## Ce que le cadrage a établi

**La garde n'est pas un oubli défensif, elle porte quatre décisions.** `thread.botId` n'est pas seulement lu pour être journalisé ; il pilote le run de bout en bout :

| Site | Ce que `thread.botId` décide |
|---|---|
| `history-compaction.ts:501` | `deps.resolveModel({ userId, spaceId, botId })` — quel modèle et **quelle credential chiffrée** font le résumé |
| `history-compaction.ts:600` | `memoryContext.botId` — l'identité sous laquelle la mémoire sémantique est écrite |
| `history-compaction.ts:609` | `scope: "isolated"` + `botId` — le conteneur où le résumé atterrit |
| `history-compaction.ts:640` | `purgeHistory({ botId, generations })` — sous quelle identité une génération obsolète est purgée |

**Le scope isolé rend le choix visible pour l'utilisateur, pas seulement interne.** `supermemory-memory-provider.ts:90-93` : un souvenir `isolated` est étiqueté `rakazo:${botId}`, un souvenir `shared` porte en plus `rakazo:workspace:${spaceId}`. Un résumé écrit en `isolated` sous le bot A est donc **invisible au rappel des autres membres du groupe**. Désigner un propriétaire arbitraire ne partage pas le résumé : il le donne à un seul membre. C'est le cœur de la décision, pas un détail d'implémentation.

**Trois issues, pas deux :**

1. **Propriétaire désigné** — un membre (le créateur du groupe ? le premier membre ?) porte le run. Diff minimal, mais son modèle et sa credential paient pour tout le monde, et le résumé n'entre que dans sa mémoire.
2. **Scope `shared` pour les threads de groupe** — le résumé va dans le conteneur d'espace, lisible par tous les membres. Reste à trancher qui exécute le run (modèle et credential), et cela élargit le périmètre de données d'un souvenir de conversation.
3. **Ne pas lever la garde** — les threads de groupe ne compactent pas, leur historique reste borné par la fenêtre de chargement (`take: LEGACY_HISTORY_WINDOW_SIZE`, 200 messages). Statu quo assumé plutôt que subi, à consigner comme tel.

**L'enfilage est déjà en place, la garde est la seule chose qui manque.** `shouldEnqueueCompaction` est appelé en fin de run sans condition sur le groupe (`executor.ts:4407`) : le job `history.compact` est bien enfilé pour un thread de groupe, il ressort simplement en no-op à la ligne 357. Lever la garde ne demande aucune plomberie d'ordonnancement.

**Conséquence sur le ticket 11 (mergé).** Le ticket 11 attribue les tours des bots membres dans le transcrit envoyé au modèle de résumé. Sa branche groupe est correcte mais **inatteignable** tant que la garde tient. Ses deux tests donnent à la fixture un `botId` *et* un `groupId` — une ligne que l'application ne produit jamais. Aucune entrée CHANGELOG ne lui a été associée pour cette raison : rien n'est observable par un utilisateur aujourd'hui. Le code du 11 est prêt et attend cette décision, il n'y a rien à réimplémenter.

**Hors périmètre.** Ce ticket ne tranche pas le partage de mémoire entre membres d'un groupe en général (seulement pour le résumé d'historique), ni la résolution de credential quand aucun membre n'en a une (le fallback déploiement de `history-compaction.ts:509-519` s'applique tel quel).

## Critère de décision

- Si la mémoire sémantique n'est pas activée sur les déploiements réels → le point 2 (scope) est théorique ; trancher sur le seul critère modèle/credential, option 1
- Si des threads de groupe dépassent régulièrement 200 messages → ne pas lever la garde coûte de l'historique perdu ; mesurer avant d'arbitrer
- Si aucun thread de groupe n'approche la fenêtre → option 3, consigner et refermer

**Blocked by:** Rien pour décider. Le ticket 11 (`deace1de`) est mergé et fournit déjà le code d'attribution que la levée de garde activerait.

**Status:** needs-decision

- [ ] Volume relevé : nombre de messages des threads de groupe existants, part au-dessus de 200
- [ ] Activation réelle de la mémoire sémantique vérifiée sur les déploiements concernés
- [ ] Choix du propriétaire tranché et consigné, ou statu quo assumé
- [ ] Si levée : scope du souvenir (`isolated` sous le propriétaire vs `shared` sur l'espace) tranché explicitement, pas hérité par défaut
- [ ] Si levée : ticket d'implémentation créé — garde `history-compaction.ts:357`, résolution du propriétaire, entrée CHANGELOG (le comportement devient observable), fixtures de test alignées sur une ligne que l'application produit
- [ ] Si statu quo : noter dans le ticket 11 que sa branche groupe reste dormante, pour qu'une relecture future ne la prenne pas pour du code mort
