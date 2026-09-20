# 04: Calculer le budget hors-historique au lieu de le supposer

**What to build:** Le calcul de la fenêtre d'historique réserve aujourd'hui une constante en dur pour « tout ce qui n'est pas l'historique » (instructions système, schémas d'outils, mémoire, scratchpad, annuaire). Un commentaire dans le code assume déjà que c'est une approximation. Elle est fausse dans les deux sens : un bot minimal gaspille de la fenêtre, un bot avec beaucoup d'outils connecteurs et une grosse mémoire durable la dépasse largement — la mémoire seule peut peser plusieurs milliers de tokens.

Le budget devient un nombre calculé au moment du run à partir de ce qui est déjà chargé : blocs mémoire et scratchpad, annuaire des pairs, schémas d'outils. Même heuristique d'estimation qu'au ticket 01. La constante reste comme valeur par défaut quand l'appelant ne fournit rien, donc aucun appelant existant ne change de comportement sans le demander.

Ce ticket n'a d'effet que sur les runs qui budgétisent en tokens : il faut la fenêtre de contexte du ticket 03 branchée, sinon il ne change rien pour la majorité des providers.

**Blocked by:** 03 (fenêtre de contexte depuis le catalogue)

**Status:** ready-for-agent

- [ ] La sélection de fenêtre accepte une estimation hors-historique fournie par l'appelant, la constante restant le défaut
- [ ] L'executor fournit cette estimation à partir des blocs réellement chargés pour le run
- [ ] Pas de nouvelle abstraction : un nombre calculé, pas une interface de budget
- [ ] Test : un run à gros contexte non-historique retient moins de messages qu'un run à petit contexte, à fenêtre de modèle égale
- [ ] L'écart entre estimation et tokens input réels reste dans un rapport stable, observable via le log du ticket 01
