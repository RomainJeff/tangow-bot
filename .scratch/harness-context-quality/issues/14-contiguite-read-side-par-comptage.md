# 14: Remplacer la garde de contiguïté read-side par un comptage

**What to build:** Un bot dont le thread a un résumé de compaction valide s'en sert, même quand les messages chargés ne commencent pas juste après le curseur. Aujourd'hui `selectCompactedHistory` valide le résumé en exigeant que les seq chargés forment une suite contiguë depuis `historyCompactedUpToSeq + 1`. Cette exigence est fausse dans deux cas réels et courants :

- le chargement de l'historique d'un run est plafonné à 200 lignes, donc sur un thread long les lignes chargées commencent bien après le curseur ;
- dans un thread de groupe, un filtre de rôle/channel retire des lignes, ce qui troue la suite des seq chargés.

Dans les deux cas le résumé est parfaitement valide, mais la garde le rejette et le run retombe sur la fenêtre legacy complète — exactement le comportement que la compaction était censée supprimer. Le coût est silencieux : plus de tokens par run, aucune erreur.

La garde read-side ne peut pas distinguer « message supprimé » de « message non chargé » parce qu'elle ne voit qu'un sous-ensemble filtré de la table. Un comptage le peut : `message.count({ threadId, seq: { gt: cursor } })` comparé au nombre de lignes non compactées effectivement chargées répond à la vraie question — « manque-t-il un message qui existe ? » — au lieu d'une approximation par arithmétique de seq.

Attention à l'ordre imposé par le ticket 13 : les lignes `system` (les apartés de thread) consomment un seq et sont retirées **après** `selectCompactedHistory`, jamais avant. Un comptage naïf côté base inclura ces lignes alors que la sélection ne les a pas encore retirées — le calcul doit rester cohérent avec ce que la sélection voit à ce moment-là, pas avec ce que l'exécuteur gardera ensuite.

Ce ticket est une amélioration indépendante, pas un correctif : le blocage de compaction sur les threads rembobinés est déjà corrigé côté écriture.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Un thread long dont l'historique chargé est plafonné utilise son résumé au lieu de retomber sur la fenêtre legacy
- [ ] Un thread de groupe dont le filtre de rôle retire des lignes utilise son résumé
- [ ] Un thread à qui il manque réellement un message entre le curseur et la fenêtre chargée retombe toujours sur la fenêtre legacy — le vrai cas de garde est préservé
- [ ] Les apartés `system` restent retirés après la sélection, pas avant ; le test existant sur cet ordre passe sans modification
- [ ] Le surcoût est d'une requête de comptage par run, mesuré et jugé acceptable, ou bien l'approche est abandonnée et le ticket clos avec ce constat
