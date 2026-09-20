# 07: Rappeler la mémoire sémantique dès le premier tour

**What to build:** Le rappel automatique de mémoire sémantique n'est déclenché aujourd'hui que si le thread a déjà été compacté. Sur un thread neuf ou court, rien de ce que le bot a mémorisé ailleurs ne remonte, sauf s'il pense à appeler l'outil de rappel — qui, lui, n'a pas cette garde. L'incohérence n'est pas défendue par un commentaire : c'est un couplage hérité entre compaction et mémoire.

La condition devient : mémoire sémantique activée pour ce thread et périmètre mémoire disponible. La génération d'historique passée au provider reste celle du thread (zéro par défaut) ; à vérifier avant de livrer que le provider ne suppose pas une génération non nulle pour retourner les mémoires qui ne viennent pas de l'historique. Si c'est le cas, le ticket s'arrête et devient une décision produit, pas un correctif.

Le coût contextuel reste borné par le plafond existant de mémoires rappelées, et le rappel tourne déjà en parallèle des autres chargements.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Le rappel automatique ne dépend plus de l'existence d'une compaction
- [x] Vérifié explicitement : le provider mémoire retourne bien les mémoires hors-historique à la génération par défaut ; sinon le ticket est refermé avec le constat
- [x] Nombre de mémoires rappelées toujours borné par le plafond existant
- [x] Les runs de canaux de messagerie restent sans rappel (frontière de confidentialité, voir non-objectifs)
- [x] Test offline avec un provider mémoire scripté : un thread jamais compacté reçoit bien le bloc de mémoire rappelée

Vérification du provider (préalable) : les deux providers de mémoire sémantique retournent les mémoires hors-historique à la génération par défaut. Supermemory construit les tags de rappel à partir du périmètre durable et n'ajoute le conteneur d'historique que lorsqu'une génération est fournie ; Serenity ignore complètement la génération d'historique. Le correctif était donc livrable.
