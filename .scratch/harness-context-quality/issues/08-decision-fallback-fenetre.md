# 08: Décision — simplifier le fallback de fenêtre en nombre de messages

**What to build:** Une décision, pas du code. Le nombre de messages conservés en fallback dépend aujourd'hui d'une condition triple (mémoire sémantique activée, thread compacté, rappel réussi) qui choisit entre deux tailles. Cette logique défensive ne joue que dans la branche fallback — celle qui, une fois le ticket 03 livré, ne concerne plus que les modèles absents du catalogue.

Question à trancher : garde-t-on la condition triple, ou la supprime-t-on au profit d'une seule taille de fallback ? Supprimer, c'est moins de code et moins de tests pour un chemin devenu rare ; garder, c'est une assurance sur les modèles exotiques.

À instruire après que le ticket 03 tourne en conditions réelles, avec le chiffre qui manque aujourd'hui : quelle part des runs passe encore par le fallback.

**Blocked by:** 03 (fenêtre de contexte depuis le catalogue)

**Status:** needs-decision

- [ ] Part des runs en fallback mesurée après livraison du ticket 03
- [ ] Décision tranchée et consignée : simplifier ou garder
- [ ] Si simplifier : ticket de suppression créé, avec les tests correspondants
