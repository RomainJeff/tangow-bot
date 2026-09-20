# 15: Débloquer la reconstruction de couverture legacy sur un thread rembobiné

**What to build:** Un thread antérieur au suivi de génération, dont l'historique a été rembobiné avant d'avoir jamais produit un résumé, finit par se compacter au lieu de rester bloqué pour toujours.

La branche de bootstrap legacy de `compactHistory` reconstruit une couverture pour un thread qui a un curseur hérité mais pas de résumé local. Elle exige que les lignes lues soient contiguës et qu'elles commencent au seq 0 (sauf thread vidé). Un rembobinage supprime des messages sans rembobiner `nextMessageSeq`, donc il laisse un trou permanent dans les seq — et la branche renonce, définitivement, avant toute écriture de curseur. Même forme de blocage que celui corrigé côté batch.

Le raisonnement qui a permis ce correctif **ne se transpose pas ici** : la requête de bootstrap est plafonnée (`take: 201`) et triée en ordre décroissant, donc une ligne de tête manquante peut vraiment vouloir dire « plafond atteint » plutôt que « supprimée ». La garde protège ici un risque réel, et la distinction entre les deux causes demande une vérification supplémentaire — par exemple un comptage sur l'intervalle, ou la comparaison du seq le plus bas réellement présent dans le thread.

Périmètre étroit : seuls les threads en génération 0 avec un curseur et sans résumé sont concernés. Vérifier d'abord combien il en reste ; s'il n'y en a plus, clore le ticket en supprimant la branche plutôt qu'en la corrigeant.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Le nombre de threads concernés est mesuré avant toute implémentation, et la décision (corriger ou supprimer la branche) est prise sur ce chiffre
- [ ] Si la branche est conservée : un thread legacy rembobiné reconstruit sa couverture et avance son curseur
- [ ] Un thread legacy dont l'historique dépasse réellement le plafond de lecture continue de renoncer, sans jamais écrire un curseur qui ment sur sa couverture
- [ ] Les trois tests existants de la branche bootstrap legacy passent sans modification
